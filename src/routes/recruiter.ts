import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { HttpError } from '../lib/errors';
import { BRANCHES } from '../lib/constants';
import { extractSkillsFromText } from '../lib/aiService';
import { requireAuth, requireRole } from '../middleware/auth';
import { randomUUID } from 'node:crypto';
import { collegeProfile, companyProfile } from '../lib/profiles';
import { imageType, imageUpload, publicUrl } from '../lib/images';

export const recruiterRouter = Router();
recruiterRouter.use(requireAuth, requireRole('recruiter'));

export const jobSchema = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(20, 'Describe the role in at least 20 characters').max(5000),
  location: z.string().trim().max(120).optional(),
  jobType: z.enum(['full_time', 'internship', 'contract']).default('full_time'),
  package: z.string().trim().max(60).optional(),
  applyBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD').optional(),
  minCgpa: z.number().min(0).max(10).default(0),
  maxBacklogs: z.number().int().min(0).max(30).nullable().optional(),
  branches: z.array(z.enum(BRANCHES)).max(7).default([]),
  graduationYear: z.number().int().min(2020).max(2040).nullable().optional(),
  requiredSkills: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
  testDurationMinutes: z.number().int().min(5).max(180).default(30),
  passPercent: z.number().int().min(1).max(100).default(60),
});

export const questionSchema = z
  .object({
    question: z.string().trim().min(5).max(500),
    options: z.array(z.string().trim().min(1).max(200)).min(2).max(6),
    correctIndex: z.number().int().min(0),
    category: z.enum(['technical', 'aptitude', 'coding']).default('technical'),
    codeSnippet: z.string().trim().max(2000).nullish(),
    source: z.enum(['manual', 'pdf', 'ai']).default('manual'),
  })
  .refine((q) => q.correctIndex < q.options.length, {
    message: 'The correct answer must be one of the options',
    path: ['correctIndex'],
  });

export function dedupe(names: string[]) {
  const seen = new Set<string>();
  return names.filter((n) => {
    const key = n.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Every job route goes through this, so a recruiter can only ever touch their own jobs.
async function ownedJob(jobId: string, userId: string) {
  const { data } = await supabaseAdmin
    .from('jobs')
    .select('*')
    .eq('id', jobId)
    .eq('created_by', userId)
    .maybeSingle();
  if (!data) throw new HttpError(404, 'Job not found');
  return data;
}

recruiterRouter.post('/extract-skills', async (req, res) => {
  const { text } = z.object({ text: z.string().trim().min(20).max(20000) }).parse(req.body);
  const skills = await extractSkillsFromText(text);
  if (!skills) throw new HttpError(503, 'Skill suggestions are unavailable right now. Add the skills yourself.');
  res.json({ skills });
});

recruiterRouter.post('/jobs', async (req, res) => {
  const b = jobSchema.parse(req.body);
  const userId = req.auth!.userId;

  const { data: rec } = await supabaseAdmin
    .from('recruiters')
    .select('company_id, companies(name, website)')
    .eq('user_id', userId)
    .single();
  const company: any = Array.isArray(rec?.companies) ? rec?.companies[0] : rec?.companies;
  if (!rec || !company) throw new HttpError(500, 'Could not load your company');

  const { data, error } = await supabaseAdmin
    .from('jobs')
    .insert({
      title: b.title,
      description: b.description,
      company_name: company.name,
      company_website: company.website,
      company_id: rec.company_id,
      location: b.location || null,
      job_type: b.jobType,
      package: b.package || null,
      apply_by: b.applyBy ?? null,
      min_cgpa: b.minCgpa,
      max_backlogs: b.maxBacklogs ?? null,
      branches: b.branches,
      graduation_year: b.graduationYear ?? null,
      required_skills: dedupe(b.requiredSkills),
      test_duration_minutes: b.testDurationMinutes,
      pass_percent: b.passPercent,
      created_by: userId,
      creator_role: 'recruiter',
    })
    .select('id')
    .single();
  if (error || !data) {
    console.error(error);
    throw new HttpError(500, 'Could not create the job');
  }
  res.status(201).json({ id: data.id });
});

recruiterRouter.get('/jobs', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('jobs')
    .select(
      'id, title, job_type, package, apply_by, is_closed, created_at, job_colleges(status), job_questions(count), applications(status)'
    )
    .eq('created_by', req.auth!.userId)
    .order('created_at', { ascending: false });
  if (error) throw new HttpError(500, 'Could not load your jobs');

  res.json(
    (data ?? []).map((j: any) => ({
      id: j.id,
      title: j.title,
      jobType: j.job_type,
      package: j.package,
      applyBy: j.apply_by,
      isClosed: j.is_closed,
      createdAt: j.created_at,
      questionCount: j.job_questions?.[0]?.count ?? 0,
      collegesSent: j.job_colleges.length,
      collegesApproved: j.job_colleges.filter((c: any) => c.status === 'approved').length,
      applicants: j.applications.length,
      qualified: j.applications.filter((a: any) => a.status === 'qualified' || a.status === 'selected').length,
    }))
  );
});

recruiterRouter.get('/jobs/:id', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const job = await ownedJob(id, req.auth!.userId);

  const [questions, colleges, apps] = await Promise.all([
    supabaseAdmin
      .from('job_questions')
      .select('id, position, question, options, correct_index, source, category, code_snippet')
            .eq('job_id', id)
      .order('position'),
    supabaseAdmin
      .from('job_colleges')
      .select('status, sent_at, decided_at, colleges(id, name, city, state)')
      .eq('job_id', id)
      .order('sent_at'),
    supabaseAdmin.from('applications').select('college_id, status').eq('job_id', id),
  ]);
  if (questions.error || colleges.error || apps.error) throw new HttpError(500, 'Could not load the job');

  // College-wise funnel: how many applied, how many are still to take the test, how many qualified.
  const funnel = new Map<string, { applicants: number; testPending: number; qualified: number; notQualified: number }>();
  for (const a of apps.data ?? []) {
    const f = funnel.get(a.college_id) ?? { applicants: 0, testPending: 0, qualified: 0, notQualified: 0 };
    f.applicants += 1;
    if (a.status === 'applied') f.testPending += 1;
    else if (a.status === 'not_qualified' || a.status === 'rejected') f.notQualified += 1;
    else f.qualified += 1;
    funnel.set(a.college_id, f);
  }

  res.json({
    id: job.id,
    title: job.title,
    description: job.description,
    companyName: job.company_name,
    location: job.location,
    jobType: job.job_type,
    package: job.package,
    applyBy: job.apply_by,
    minCgpa: job.min_cgpa,
    maxBacklogs: job.max_backlogs,
    branches: job.branches,
    graduationYear: job.graduation_year,
    requiredSkills: job.required_skills,
    testDurationMinutes: job.test_duration_minutes,
    passPercent: job.pass_percent,
    isClosed: job.is_closed,
    createdAt: job.created_at,
    // Questions are locked once anyone has applied, otherwise earlier scores would no longer make sense.
    canEditQuestions: (apps.data ?? []).length === 0,
    questions: (questions.data ?? []).map((q: any) => ({
      id: q.id,
      position: q.position,
      question: q.question,
      options: q.options,
      correctIndex: q.correct_index,
      source: q.source,
            category: q.category,
      codeSnippet: q.code_snippet ?? '',
    })),
    colleges: (colleges.data ?? []).map((c: any) => ({
      collegeId: c.colleges?.id,
      name: c.colleges?.name,
      city: c.colleges?.city,
      state: c.colleges?.state,
      status: c.status,
      sentAt: c.sent_at,
      decidedAt: c.decided_at,
      ...(funnel.get(c.colleges?.id) ?? { applicants: 0, testPending: 0, qualified: 0, notQualified: 0 }),
    })),
  });
});

// Replaces the whole question list. The recruiter's screen always sends the full list.
recruiterRouter.put('/jobs/:id/questions', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const { questions } = z.object({ questions: z.array(questionSchema).min(1).max(50) }).parse(req.body);
  await ownedJob(id, req.auth!.userId);

  const { count } = await supabaseAdmin
    .from('applications')
    .select('id', { count: 'exact', head: true })
    .eq('job_id', id);
  if (count) throw new HttpError(409, 'Students have already applied, so the test can no longer be changed');

  const { error: delErr } = await supabaseAdmin.from('job_questions').delete().eq('job_id', id);
  if (delErr) throw new HttpError(500, 'Could not save the questions');

  const { error } = await supabaseAdmin.from('job_questions').insert(
    questions.map((q, i) => ({
      job_id: id,
      position: i + 1,
      question: q.question,
      options: q.options,
      correct_index: q.correctIndex,
      source: q.source,
            category: q.category,
      code_snippet: q.codeSnippet || null,
    }))
  );
  if (error) {
    console.error(error);
    throw new HttpError(500, 'Could not save the questions. Please try again');
  }
  res.json({ count: questions.length });
});

recruiterRouter.patch('/jobs/:id/close', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  await ownedJob(id, req.auth!.userId);
  const { error } = await supabaseAdmin.from('jobs').update({ is_closed: true }).eq('id', id);
  if (error) throw new HttpError(500, 'Could not close the job');
  res.json({ isClosed: true });
});


// ---------- Colleges: browse, with an aggregate profile of each ----------

function round(n: number) {
  return Math.round(n * 100) / 100;
}

// Only counts and averages ever leave this function, never anything about an individual student.
function collegeStats(rows: any[]) {
  const withCgpa = rows.filter((r) => r.cgpa != null);
  const branches = new Map<string, number>();
  const skills = new Map<string, number>();
  for (const r of rows) {
    branches.set(r.branch, (branches.get(r.branch) ?? 0) + 1);
    for (const s of Array.isArray(r.parsed_skills) ? r.parsed_skills : []) {
      skills.set(s.name, (skills.get(s.name) ?? 0) + 1);
    }
  }
  const sorted = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  return {
    students: rows.length,
    avgCgpa: withCgpa.length ? round(withCgpa.reduce((sum, r) => sum + Number(r.cgpa), 0) / withCgpa.length) : null,
    withResume: rows.filter((r) => r.resume_path).length,
    zeroBacklogs: rows.filter((r) => r.backlogs === 0).length,
    branches: sorted(branches).map(([branch, count]) => ({ branch, count })),
    topSkills: sorted(skills)
      .slice(0, 8)
      .map(([name, count]) => ({ name, count })),
  };
}

recruiterRouter.get('/colleges', async (_req, res) => {
  const { data: colleges, error } = await supabaseAdmin
    .from('colleges')
    .select('id, name, city, state')
    .eq('status', 'approved')
    .order('name')
    .limit(100);
  if (error) throw new HttpError(500, 'Could not load colleges');
  if (!colleges?.length) return res.json([]);

  const { data: students, error: sErr } = await supabaseAdmin
    .from('student_details')
    .select('college_id, branch, cgpa, backlogs, resume_path, parsed_skills')
    .in(
      'college_id',
      colleges.map((c) => c.id)
    );
  if (sErr) throw new HttpError(500, 'Could not load colleges');

  res.json(
    colleges.map((c) => ({
      id: c.id,
      name: c.name,
      city: c.city,
      state: c.state,
      ...collegeStats((students ?? []).filter((s) => s.college_id === c.id)),
    }))
  );
});

// ---------- Send a job to several colleges ----------

recruiterRouter.post('/jobs/:id/send', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const { collegeIds } = z.object({ collegeIds: z.array(z.string().uuid()).min(1).max(50) }).parse(req.body);
  const job = await ownedJob(id, req.auth!.userId);
  if (job.is_closed) throw new HttpError(409, 'This job is closed');

  const { count } = await supabaseAdmin
    .from('job_questions')
    .select('id', { count: 'exact', head: true })
    .eq('job_id', id);
  if (!count) throw new HttpError(400, 'Add the test questions before sending the job to colleges');

  const { data: valid } = await supabaseAdmin
    .from('colleges')
    .select('id')
    .in('id', collegeIds)
    .eq('status', 'approved');
  const validIds = (valid ?? []).map((c) => c.id);
  if (!validIds.length) throw new HttpError(404, 'No valid colleges selected');

  // ignoreDuplicates: a college that already decided keeps its decision.
  const { error } = await supabaseAdmin
    .from('job_colleges')
    .upsert(
      validIds.map((collegeId) => ({ job_id: id, college_id: collegeId })),
      { onConflict: 'job_id,college_id', ignoreDuplicates: true }
    );
  if (error) {
    console.error(error);
    throw new HttpError(500, 'Could not send the job');
  }
  res.json({ sent: validIds.length });
});


// ---------- Finding colleges: filters, search and a full profile ----------

// Every approved college, in the smallest form, so the State / District / College dropdowns can be built.
recruiterRouter.get('/directory/filters', async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('colleges')
    .select('id, name, state, district')
    .eq('status', 'approved')
    .order('name')
    .limit(500);
  if (error) throw new HttpError(500, 'Could not load colleges');
  res.json({ colleges: data ?? [] });
});

recruiterRouter.get('/directory', async (req, res) => {
  const f = z
    .object({
      q: z.string().trim().max(80).optional(),
      state: z.string().trim().max(80).optional(),
      district: z.string().trim().max(80).optional(),
      collegeId: z.string().uuid().optional(),
    })
    .parse(req.query);

  let query = supabaseAdmin
    .from('colleges')
    .select('id, name, city, state, district')
    .eq('status', 'approved')
    .order('name')
    .limit(50);
  if (f.state) query = query.eq('state', f.state);
  if (f.district) query = query.eq('district', f.district);
  if (f.collegeId) query = query.eq('id', f.collegeId);
  if (f.q) query = query.ilike('name', `%${f.q.replace(/[%_]/g, '')}%`);

  const { data, error } = await query;
  if (error) throw new HttpError(500, 'Could not search colleges');
  if (!data?.length) return res.json([]);

  const { data: photos } = await supabaseAdmin
    .from('college_photos')
    .select('college_id, path, position')
    .in('college_id', data.map((c) => c.id))
    .order('position');
  const thumb = new Map<string, string>();
  for (const p of photos ?? []) {
    if (!thumb.has(p.college_id)) thumb.set(p.college_id, publicUrl('college-photos', p.path));
  }
  res.json(data.map((c) => ({ ...c, thumb: thumb.get(c.id) ?? null })));
});

// Everything the "View college profile" window shows: the details the TPO filled in, plus live numbers.
recruiterRouter.get('/colleges/:id/profile', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const profile = await collegeProfile(id);

  const { data: college } = await supabaseAdmin.from('colleges').select('status').eq('id', id).single();
  if (college?.status !== 'approved') throw new HttpError(404, 'College not found');

  const { data: students } = await supabaseAdmin
    .from('student_details')
    .select('branch, cgpa, backlogs, resume_path, parsed_skills')
    .eq('college_id', id);
  res.json({ ...profile, stats: collegeStats(students ?? []) });
});

// ---------- The recruiter's company profile (shown to TPOs) ----------

async function myCompanyId(userId: string) {
  const { data } = await supabaseAdmin.from('recruiters').select('company_id').eq('user_id', userId).single();
  if (!data) throw new HttpError(500, 'Could not load your company');
  return data.company_id as string;
}

recruiterRouter.get('/company-profile', async (req, res) => {
  res.json(await companyProfile(await myCompanyId(req.auth!.userId)));
});

const companyProfileSchema = z.object({
  about: z.string().trim().max(3000).optional(),
  industry: z.string().trim().max(80).optional(),
  companySize: z.string().trim().max(40).optional(),
  foundedYear: z.number().int().min(1800).max(2100).nullable().optional(),
  headquarters: z.string().trim().max(120).optional(),
  website: z.string().trim().url().optional().or(z.literal('')),
  linkedinUrl: z.string().trim().url().optional().or(z.literal('')),
});

recruiterRouter.put('/company-profile', async (req, res) => {
  const b = companyProfileSchema.parse(req.body);
  const companyId = await myCompanyId(req.auth!.userId);
  const { error } = await supabaseAdmin
    .from('companies')
    .update({
      about: b.about || null,
      industry: b.industry || null,
      company_size: b.companySize || null,
      founded_year: b.foundedYear ?? null,
      headquarters: b.headquarters || null,
      website: b.website || null,
      linkedin_url: b.linkedinUrl || null,
    })
    .eq('id', companyId);
  if (error) throw new HttpError(500, 'Could not save the company profile');
  res.json(await companyProfile(companyId));
});

recruiterRouter.post('/company-logo', imageUpload.single('logo'), async (req, res) => {
  const file = req.file;
  if (!file) throw new HttpError(400, 'Choose an image');
  const kind = imageType(file.buffer);
  if (!kind) throw new HttpError(400, 'Only JPG, PNG or WebP images are accepted');

  const companyId = await myCompanyId(req.auth!.userId);
  const path = `${companyId}/${randomUUID()}.${kind.ext}`;
  const { error: upErr } = await supabaseAdmin.storage
    .from('company-logos')
    .upload(path, file.buffer, { contentType: kind.mime });
  if (upErr) throw new HttpError(500, 'Could not store the logo');

  const { data: old } = await supabaseAdmin.from('companies').select('logo_path').eq('id', companyId).single();
  const { error } = await supabaseAdmin.from('companies').update({ logo_path: path }).eq('id', companyId);
  if (error) throw new HttpError(500, 'Could not save the logo');
  if (old?.logo_path) await supabaseAdmin.storage.from('company-logos').remove([old.logo_path]);
  res.json(await companyProfile(companyId));
});