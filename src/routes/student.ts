import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { HttpError } from '../lib/errors';
import { parseResume } from '../lib/aiService';
import { requireAuth, requireRole } from '../middleware/auth';
import { imageType, imageUpload } from '../lib/images';

export const studentRouter = Router();
studentRouter.use(requireAuth, requireRole('student'));

const BUCKET = 'resumes';
const MAX_BYTES = 5 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
});

const COLS =
  'roll_no, branch, graduation_year, cgpa, backlogs, resume_path, parsed_skills, parsed_at, skills_reviewed_at, github_url, linkedin_url, avatar_path';

// Never expose storage paths to the client, only whether a file exists.
function shape(row: any) {
  const { resume_path, avatar_path, ...rest } = row;
  return { ...rest, has_resume: !!resume_path, has_avatar: !!avatar_path };
}

// Profile photos live in a private bucket, so the app is given a short-lived link instead of a path.
async function avatarUrl(path: string | null | undefined) {
  if (!path) return null;
  const { data } = await supabaseAdmin.storage.from('avatars').createSignedUrl(path, 3600);
  return data?.signedUrl ?? null;
}

// Runs the AI scan and stores the result. Never throws: a failed scan must not undo a good upload.
async function parseAndStore(userId: string, pdf: Buffer) {
  const parsed = await parseResume(pdf);
  if (!parsed.ok) return { status: 'failed' as const, message: parsed.message };

  const { error } = await supabaseAdmin
    .from('student_details')
        .update({
      parsed_skills: parsed.skills,
      parsed_at: new Date().toISOString(),
      skills_reviewed_at: null,
      // Only overwrite a link when the new resume actually contains one.
      ...(parsed.githubUrl ? { github_url: parsed.githubUrl } : {}),
      ...(parsed.linkedinUrl ? { linkedin_url: parsed.linkedinUrl } : {}),
    })
    .eq('user_id', userId);
  if (error) {
    console.error('Could not store parsed skills', error);
    return { status: 'failed' as const, message: 'Could not save your skills. Try again.' };
  }
  return { status: 'ok' as const, skills_count: parsed.skills.length };
}

studentRouter.get('/profile', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('student_details')
    .select(COLS)
    .eq('user_id', req.auth!.userId)
    .single();
  if (error || !data) throw new HttpError(500, 'Could not load your profile');
  res.json({ ...shape(data), avatar_url: await avatarUrl(data.avatar_path) });
});

studentRouter.patch('/profile', async (req, res) => {
  const body = z
    .object({
      cgpa: z.number().min(0).max(10).transform((n) => Math.round(n * 100) / 100),
      backlogs: z.number().int().min(0).max(30),
    })
    .parse(req.body);

  const { data, error } = await supabaseAdmin
    .from('student_details')
    .update({ cgpa: body.cgpa, backlogs: body.backlogs })
    .eq('user_id', req.auth!.userId)
    .select(COLS)
    .single();
  if (error || !data) throw new HttpError(500, 'Could not save your profile');
  res.json(shape(data));
});

studentRouter.post('/resume', upload.single('resume'), async (req, res) => {
  const file = req.file;
  if (!file) throw new HttpError(400, 'Choose a PDF file to upload');

  // Check the file's real first bytes, not just the name the phone reports.
  if (file.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new HttpError(400, 'Only PDF resumes are accepted');
  }

  const userId = req.auth!.userId;
  const path = `${userId}/resume.pdf`;

  const { error: upErr } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(path, file.buffer, { contentType: 'application/pdf', upsert: true });
  if (upErr) throw new HttpError(500, 'Could not store your resume');

  // A new file makes any earlier scan and review stale.
  const { error } = await supabaseAdmin
    .from('student_details')
    .update({ resume_path: path, parsed_skills: null, parsed_at: null, skills_reviewed_at: null })
    .eq('user_id', userId);
  if (error) throw new HttpError(500, 'Could not save your resume');

  const parse = await parseAndStore(userId, file.buffer);
  res.status(201).json({ has_resume: true, parse });
});

// Short-lived link so the student can open their own resume.
studentRouter.get('/resume', async (req, res) => {
  const { data: row } = await supabaseAdmin
    .from('student_details')
    .select('resume_path')
    .eq('user_id', req.auth!.userId)
    .single();
  if (!row?.resume_path) throw new HttpError(404, 'No resume uploaded yet');

  const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(row.resume_path, 60);
  if (error || !data) throw new HttpError(500, 'Could not open your resume');
  res.json({ url: data.signedUrl });
});

// Re-scan the saved resume, for when the AI service was down during upload.
studentRouter.post('/resume/parse', async (req, res) => {
  const userId = req.auth!.userId;
  const { data: row } = await supabaseAdmin
    .from('student_details')
    .select('resume_path')
    .eq('user_id', userId)
    .single();
  if (!row?.resume_path) throw new HttpError(404, 'Upload a resume first');

  const { data: blob, error } = await supabaseAdmin.storage.from(BUCKET).download(row.resume_path);
  if (error || !blob) throw new HttpError(500, 'Could not read your resume');

  const pdf = Buffer.from(await blob.arrayBuffer());
  res.json({ parse: await parseAndStore(userId, pdf) });
});

// The student's reviewed skill list replaces whatever the scan found.
const skillSchema = z.object({
  name: z.string().trim().min(1).max(40),
  category: z.string().trim().min(1).max(40).default('Other'),
  source: z.enum(['skills_section', 'body', 'manual']).default('manual'),
});

studentRouter.put('/skills', async (req, res) => {
  const { skills } = z.object({ skills: z.array(skillSchema).max(100) }).parse(req.body);

  const seen = new Set<string>();
  const unique = skills.filter((s) => {
    const key = s.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const { data, error } = await supabaseAdmin
    .from('student_details')
    .update({ parsed_skills: unique, skills_reviewed_at: new Date().toISOString() })
    .eq('user_id', req.auth!.userId)
    .select(COLS)
    .single();
  if (error || !data) throw new HttpError(500, 'Could not save your skills');
  res.json(shape(data));
});


// ---------- Jobs, applications and the MCQ test ----------

const one = (v: any) => (Array.isArray(v) ? v[0] : v);

// "Node.js", "nodejs" and "Node JS" all become "nodejs", so a recruiter's spelling still matches the student's.
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9+#]/g, '');

const JOB_VIEW_COLS =
  'id, title, description, company_name, location, job_type, package, apply_by, min_cgpa, max_backlogs, branches, graduation_year, required_skills, test_duration_minutes, pass_percent, creator_role, open_to_all, is_closed, created_at';

const GRACE_MS = 30_000; // allowance for network delay when the test is submitted

async function loadStudent(userId: string) {
  const { data, error } = await supabaseAdmin
    .from('student_details')
    .select('college_id, branch, graduation_year, cgpa, backlogs, parsed_skills')
    .eq('user_id', userId)
    .single();
  if (error || !data) throw new HttpError(500, 'Could not load your profile');
  return data;
}

// A student sees jobs approved for their own college plus drives that are open to every college.
async function visibleJobs(student: any): Promise<any[]> {
  const [viaCollege, open] = await Promise.all([
    supabaseAdmin
      .from('job_colleges')
      .select(`jobs(${JOB_VIEW_COLS})`)
      .eq('college_id', student.college_id)
      .eq('status', 'approved'),
    supabaseAdmin.from('jobs').select(JOB_VIEW_COLS).eq('open_to_all', true),
  ]);
  if (viaCollege.error || open.error) throw new HttpError(500, 'Could not load jobs');

  const byId = new Map<string, any>();
  for (const r of viaCollege.data ?? []) {
    const j = one((r as any).jobs);
    if (j) byId.set(j.id, j);
  }
  for (const j of open.data ?? []) byId.set((j as any).id, j);
  return [...byId.values()]
    .filter((j) => !j.is_closed)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

async function jobViews(userId: string, jobs: any[], student: any) {
  if (!jobs.length) return [];
  const ids = jobs.map((j) => j.id as string);
  const [qs, apps] = await Promise.all([
    supabaseAdmin.from('job_questions').select('job_id').in('job_id', ids),
    supabaseAdmin
      .from('applications')
      .select('id, job_id, status, applied_at, test_attempts(started_at, submitted_at, percent, passed, terminated)')
      .eq('student_id', userId)
      .in('job_id', ids),
  ]);
  if (qs.error || apps.error) throw new HttpError(500, 'Could not load jobs');

  const questionCount = new Map<string, number>();
  for (const q of qs.data ?? []) questionCount.set(q.job_id, (questionCount.get(q.job_id) ?? 0) + 1);
  const appByJob = new Map((apps.data ?? []).map((a: any) => [a.job_id, a]));

  const have = new Set((Array.isArray(student.parsed_skills) ? student.parsed_skills : []).map((s: any) => norm(s.name)));
  const today = new Date().toISOString().slice(0, 10);

  return jobs.map((j) => {
    const required: string[] = j.required_skills ?? [];
    const matchedSkills = required.filter((s) => have.has(norm(s)));
    const missingSkills = required.filter((s) => !have.has(norm(s)));
    const matchScore = required.length ? Math.round((matchedSkills.length / required.length) * 100) : null;

    const reasons: string[] = [];
    if (j.min_cgpa > 0) {
      if (student.cgpa == null) reasons.push('Add your CGPA in Profile');
      else if (Number(student.cgpa) < Number(j.min_cgpa)) reasons.push(`Needs CGPA ${j.min_cgpa}+ (yours is ${student.cgpa})`);
    }
    if (j.max_backlogs != null) {
      if (student.backlogs == null) reasons.push('Add your backlogs in Profile');
      else if (student.backlogs > j.max_backlogs) reasons.push(`Allows at most ${j.max_backlogs} backlogs (you have ${student.backlogs})`);
    }
    if (j.branches?.length && !j.branches.includes(student.branch)) reasons.push(`Open to ${j.branches.join(', ')} only`);
    if (j.graduation_year && j.graduation_year !== student.graduation_year) reasons.push(`Open to class of ${j.graduation_year} only`);
    if (j.apply_by && j.apply_by < today) reasons.push('Applications are closed');

    const app: any = appByJob.get(j.id);
    const attempt = one(app?.test_attempts);
    return {
      id: j.id,
      title: j.title,
      description: j.description,
      companyName: j.company_name,
      location: j.location,
      jobType: j.job_type,
      package: j.package,
      applyBy: j.apply_by,
      minCgpa: j.min_cgpa,
      maxBacklogs: j.max_backlogs,
      branches: j.branches,
      graduationYear: j.graduation_year,
      requiredSkills: required,
      testDurationMinutes: j.test_duration_minutes,
      passPercent: j.pass_percent,
      questionCount: questionCount.get(j.id) ?? 0,
      isDrive: j.creator_role === 'tpo',
      openToAll: j.open_to_all,
      matchScore,
      matchedSkills,
      missingSkills,
      eligible: reasons.length === 0,
      reasons,
      application: app
        ? {
          id: app.id,
          status: app.status,
          appliedAt: app.applied_at,
          testStatus: !attempt ? 'not_started' : attempt.submitted_at ? 'submitted' : 'in_progress',
          testPercent: attempt?.submitted_at ? Number(attempt.percent) : null,
          passed: attempt?.submitted_at ? attempt.passed : null,
          terminated: !!attempt?.terminated,
        }
        : null,
    };
  });
}

async function singleJobView(userId: string, jobId: string) {
  const student = await loadStudent(userId);
  const jobs = (await visibleJobs(student)).filter((j) => j.id === jobId);
  if (!jobs.length) throw new HttpError(404, 'Job not found');
  const [view] = await jobViews(userId, jobs, student);
  return { view, student };
}

studentRouter.get('/jobs', async (req, res) => {
  const userId = req.auth!.userId;
  const student = await loadStudent(userId);
  res.json(await jobViews(userId, await visibleJobs(student), student));
});

studentRouter.get('/jobs/:id', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  res.json((await singleJobView(req.auth!.userId, id)).view);
});

studentRouter.post('/jobs/:id/apply', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const userId = req.auth!.userId;
  const { view, student } = await singleJobView(userId, id);

  if (view.application) throw new HttpError(409, 'You have already applied');
  if (!view.eligible) throw new HttpError(403, view.reasons[0]);

  // The match score is saved at the moment of applying, so later skill edits do not change old results.
  const { error } = await supabaseAdmin
    .from('applications')
    .insert({ job_id: id, student_id: userId, college_id: student.college_id, match_score: view.matchScore });
  if (error) {
    if (error.code === '23505') throw new HttpError(409, 'You have already applied');
    console.error(error);
    throw new HttpError(500, 'Could not submit your application');
  }
  res.status(201).json({ applied: true });
});

async function findApplication(userId: string, jobId: string) {
  const { data } = await supabaseAdmin
    .from('applications')
    .select('id, status, test_attempts(started_at, submitted_at)')
    .eq('job_id', jobId)
    .eq('student_id', userId)
    .maybeSingle();
  if (!data) throw new HttpError(403, 'Apply to this job first');
  return { app: data as any, attempt: one((data as any).test_attempts) };
}

// Scores on the server. The correct answers never leave it.
async function finalizeAttempt(applicationId: string, jobId: string, answers: Record<string, number>) {
  const [job, questions] = await Promise.all([
    supabaseAdmin.from('jobs').select('pass_percent').eq('id', jobId).single(),
    supabaseAdmin.from('job_questions').select('id, correct_index').eq('job_id', jobId),
  ]);
  if (job.error || questions.error || !job.data) throw new HttpError(500, 'Could not score the test');

  const total = (questions.data ?? []).length;
  const score = (questions.data ?? []).filter((q) => answers[q.id] === q.correct_index).length;
  const percent = total ? Math.round((score / total) * 10000) / 100 : 0;
  const passed = percent >= job.data.pass_percent;

  // Only an unsubmitted attempt can be finalised, so a double submit cannot overwrite a result.
  const { data: updated, error } = await supabaseAdmin
    .from('test_attempts')
    .update({ submitted_at: new Date().toISOString(), answers, score, total, percent, passed })
    .eq('application_id', applicationId)
    .is('submitted_at', null)
    .select('application_id');
  if (error) throw new HttpError(500, 'Could not save your result');
  if (!updated?.length) throw new HttpError(409, 'You have already taken this test');

  await supabaseAdmin
    .from('applications')
    .update({ status: passed ? 'qualified' : 'not_qualified' })
    .eq('id', applicationId);

  return { score, total, percent, passed, passPercent: job.data.pass_percent as number };
}

studentRouter.post('/jobs/:id/test/start', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const { app, attempt } = await findApplication(req.auth!.userId, id);
  if (attempt?.submitted_at) throw new HttpError(409, 'You have already taken this test');

  const [job, questions] = await Promise.all([
    supabaseAdmin.from('jobs').select('test_duration_minutes, pass_percent').eq('id', id).single(),
    supabaseAdmin.from('job_questions').select('id, question, options, category, code_snippet').eq('job_id', id).order('position'),  ]);
  if (job.error || !job.data || questions.error || !questions.data?.length) {
    throw new HttpError(400, 'This test is not ready yet');
  }

  let startedAt: string = attempt?.started_at;
  if (!attempt) {
    const { data, error } = await supabaseAdmin
      .from('test_attempts')
      .insert({ application_id: app.id })
      .select('started_at')
      .single();
    if (error || !data) throw new HttpError(500, 'Could not start the test');
    startedAt = data.started_at;
  }

  const deadline = new Date(startedAt).getTime() + job.data.test_duration_minutes * 60_000;
  if (Date.now() > deadline + GRACE_MS) {
    await finalizeAttempt(app.id, id, {});
    throw new HttpError(409, 'The time for this test has ended, so your attempt was scored as it stood');
  }

  const { data: vio } = await supabaseAdmin.from('test_attempts').select('violations').eq('application_id', app.id).single();

  res.json({
    remainingSeconds: Math.max(0, Math.floor((deadline - Date.now()) / 1000)),
    passPercent: job.data.pass_percent,
    violations: vio?.violations ?? 0,
    maxViolations: MAX_VIOLATIONS,
    questions: questions.data, // no correct answers here
  });
});

studentRouter.post('/jobs/:id/test/submit', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const { answers } = z.object({ answers: z.record(z.string(), z.number().int().min(0).max(10)) }).parse(req.body);
  const { app, attempt } = await findApplication(req.auth!.userId, id);
  if (!attempt) throw new HttpError(400, 'Start the test first');
  if (attempt.submitted_at) throw new HttpError(409, 'You have already taken this test');

  const { data: job } = await supabaseAdmin.from('jobs').select('test_duration_minutes').eq('id', id).single();
  const deadline = new Date(attempt.started_at).getTime() + (job?.test_duration_minutes ?? 0) * 60_000;
  const timedOut = Date.now() > deadline + GRACE_MS;

  // A submission that arrives after the time limit counts as no answers.
  const result = await finalizeAttempt(app.id, id, timedOut ? {} : answers);
  res.json({ ...result, timedOut });
});


// ---------- Progress dashboard ----------

studentRouter.get('/dashboard', async (req, res) => {
  const userId = req.auth!.userId;
  const student = await loadStudent(userId);

  const [detailsRes, appsRes, jobs] = await Promise.all([
    supabaseAdmin
      .from('student_details')
      .select('cgpa, backlogs, resume_path, parsed_skills, skills_reviewed_at')
      .eq('user_id', userId)
      .single(),
    supabaseAdmin
      .from('applications')
      .select('status, applied_at, jobs(title, company_name, pass_percent), test_attempts(percent, passed, submitted_at)')
      .eq('student_id', userId),
    visibleJobs(student),
  ]);
  if (detailsRes.error || !detailsRes.data || appsRes.error) throw new HttpError(500, 'Could not load your dashboard');
  const d: any = detailsRes.data;
  const views = await jobViews(userId, jobs, student);

  // Skills by category
  const skills: any[] = Array.isArray(d.parsed_skills) ? d.parsed_skills : [];
  const byCategory = new Map<string, number>();
  for (const s of skills) {
    const c = s.category ?? 'Other';
    byCategory.set(c, (byCategory.get(c) ?? 0) + 1);
  }

  // Profile completeness
  const checks = [
    { key: 'academics', label: 'CGPA and backlogs added', done: d.cgpa != null && d.backlogs != null },
    { key: 'resume', label: 'Resume uploaded', done: !!d.resume_path },
    { key: 'scan', label: 'Resume scanned for skills', done: d.parsed_skills != null },
    { key: 'review', label: 'Skills reviewed', done: !!d.skills_reviewed_at },
  ];
  const completeness = Math.round((checks.filter((c) => c.done).length / checks.length) * 100);

  // Match scores and the skills students are most often missing
  const scored = views.filter((v) => v.matchScore != null);
  const avgMatch = scored.length
    ? Math.round(scored.reduce((n, v) => n + (v.matchScore as number), 0) / scored.length)
    : null;
  const gapCount = new Map<string, number>();
  for (const v of views) for (const m of v.missingSkills) gapCount.set(m, (gapCount.get(m) ?? 0) + 1);

  // Applications and tests
  const apps: any[] = appsRes.data ?? [];
  const attempts = apps
    .map((a) => ({ a, t: one(a.test_attempts), job: one(a.jobs) }))
    .filter((x) => x.t?.submitted_at)
    .sort((x, y) => String(x.t.submitted_at).localeCompare(String(y.t.submitted_at)));
  const avgTest = attempts.length
    ? Math.round(attempts.reduce((n, x) => n + Number(x.t.percent), 0) / attempts.length)
    : null;

  // Readiness: a weighted average of the parts that have data. A part with no data yet is left out, not counted as zero.
  const parts = [
    { key: 'profile', label: 'Profile completeness', value: completeness as number | null, weight: 30 },
    { key: 'match', label: 'Skill match with open jobs', value: avgMatch, weight: 40 },
    { key: 'tests', label: 'Test performance', value: avgTest, weight: 30 },
  ];
  const usable = parts.filter((p) => p.value != null);
  const weightSum = usable.reduce((n, p) => n + p.weight, 0);
  const readiness = weightSum
    ? Math.round(usable.reduce((n, p) => n + (p.value as number) * p.weight, 0) / weightSum)
    : 0;

  res.json({
    readiness,
    parts,
    checks,
    completeness,
    totalSkills: skills.length,
    skillsByCategory: [...byCategory.entries()].sort((a, b) => b[1] - a[1]).map(([category, count]) => ({ category, count })),
    matchByJob: [...scored]
      .sort((a, b) => (b.matchScore as number) - (a.matchScore as number))
      .slice(0, 6)
      .map((v) => ({ title: v.title, company: v.companyName, score: v.matchScore as number })),
    skillGaps: [...gapCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([skill, jobsCount]) => ({ skill, jobs: jobsCount })),
    funnel: {
      applied: apps.length,
      tested: attempts.length,
      qualified: apps.filter((a) => a.status === 'qualified' || a.status === 'selected').length,
    },
    jobsAvailable: views.length,
    eligibleJobs: views.filter((v) => v.eligible).length,
    testScores: attempts.slice(-8).map((x) => ({
      title: x.job?.title ?? 'Job',
      percent: Number(x.t.percent),
      passPercent: x.job?.pass_percent ?? 0,
      passed: !!x.t.passed,
    })),
  });
});



// ---------- Leaving the app during a test ----------

const MAX_VIOLATIONS = 3;

// Ends an attempt as a disqualification: no score, and the application is rejected.
async function terminateAttempt(applicationId: string) {
  const { data: updated } = await supabaseAdmin
    .from('test_attempts')
    .update({ submitted_at: new Date().toISOString(), terminated: true, passed: false, percent: 0, score: 0 })
    .eq('application_id', applicationId)
    .is('submitted_at', null)
    .select('application_id');
  if (updated?.length) {
    await supabaseAdmin.from('applications').update({ status: 'rejected' }).eq('id', applicationId);
  }
}

// The app calls this each time the student comes back after leaving it mid-test.
studentRouter.post('/jobs/:id/test/violation', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const { app, attempt } = await findApplication(req.auth!.userId, id);
  if (!attempt) throw new HttpError(400, 'The test has not started');
  if (attempt.submitted_at) throw new HttpError(409, 'This test is already finished');

  // Count on the server, so reinstalling or clearing the app cannot reset the warnings.
  let violations = 0;
  for (let tries = 0; tries < 3 && !violations; tries++) {
    const { data: cur } = await supabaseAdmin
      .from('test_attempts')
      .select('violations, submitted_at')
      .eq('application_id', app.id)
      .single();
    if (!cur || cur.submitted_at) throw new HttpError(409, 'This test is already finished');

    const current = cur.violations ?? 0;
    const { data: updated, error } = await supabaseAdmin
      .from('test_attempts')
      .update({ violations: current + 1 })
      .eq('application_id', app.id)
      .eq('violations', current)
      .is('submitted_at', null)
      .select('violations');
    if (error) throw new HttpError(500, 'Could not record this');
    if (updated?.length) violations = current + 1;
  }
  if (!violations) throw new HttpError(409, 'Please try again');

  const terminated = violations >= MAX_VIOLATIONS;
  if (terminated) await terminateAttempt(app.id);
  res.json({ violations, terminated, max: MAX_VIOLATIONS });
});


// ---------- Profile photo and links ----------

const githubUrl = z
  .string()
  .trim()
  .max(200)
  .regex(/^https?:\/\/(www\.)?github\.com\/[A-Za-z0-9-]+\/?$/i, 'Use a link like https://github.com/username')
  .or(z.literal(''));
const linkedinUrl = z
  .string()
  .trim()
  .max(200)
  .regex(/^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9_%-]+\/?$/i, 'Use a link like https://www.linkedin.com/in/your-name')
  .or(z.literal(''));

studentRouter.put('/links', async (req, res) => {
  const b = z.object({ githubUrl, linkedinUrl }).parse(req.body);
  const { data, error } = await supabaseAdmin
    .from('student_details')
    .update({ github_url: b.githubUrl || null, linkedin_url: b.linkedinUrl || null })
    .eq('user_id', req.auth!.userId)
    .select(COLS)
    .single();
  if (error || !data) throw new HttpError(500, 'Could not save your links');
  res.json({ ...shape(data), avatar_url: await avatarUrl(data.avatar_path) });
});

studentRouter.post('/avatar', imageUpload.single('photo'), async (req, res) => {
  const file = req.file;
  if (!file) throw new HttpError(400, 'Choose a photo');
  const kind = imageType(file.buffer);
  if (!kind) throw new HttpError(400, 'Only JPG, PNG or WebP photos are accepted');

  const userId = req.auth!.userId;
  const path = `${userId}/avatar.${kind.ext}`;
  const { data: old } = await supabaseAdmin.from('student_details').select('avatar_path').eq('user_id', userId).single();

  const { error: upErr } = await supabaseAdmin.storage
    .from('avatars')
    .upload(path, file.buffer, { contentType: kind.mime, upsert: true });
  if (upErr) throw new HttpError(500, 'Could not store your photo');

  const { error } = await supabaseAdmin.from('student_details').update({ avatar_path: path }).eq('user_id', userId);
  if (error) throw new HttpError(500, 'Could not save your photo');

  // A different image type means a different file name, so the old one would be left behind.
  if (old?.avatar_path && old.avatar_path !== path) {
    await supabaseAdmin.storage.from('avatars').remove([old.avatar_path]);
  }
  res.status(201).json({ avatar_url: await avatarUrl(path) });
});