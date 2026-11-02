import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { HttpError } from '../lib/errors';
import { requireAuth, requireRole } from '../middleware/auth';
import { jobSchema, questionSchema, dedupe } from './recruiter';
import { randomUUID } from 'node:crypto';
import { collegeProfile, companyProfile } from '../lib/profiles';
import { imageType, imageUpload } from '../lib/images';

export const tpoRouter = Router();
tpoRouter.use(requireAuth, requireRole('tpo'));

tpoRouter.get('/recruiter-requests', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('college_recruiters')
    .select('recruiter_id, status, requested_at, recruiters(job_title, companies(name, website), profiles(full_name))')
    .eq('college_id', req.auth!.collegeId!)
    .order('requested_at', { ascending: false });
  if (error) throw new HttpError(500, 'Could not load requests');

  res.json(
    (data ?? []).map((r: any) => ({
      recruiterId: r.recruiter_id,
      status: r.status,
      requestedAt: r.requested_at,
      name: r.recruiters?.profiles?.full_name ?? 'Unknown',
      jobTitle: r.recruiters?.job_title ?? null,
      company: r.recruiters?.companies?.name ?? 'Unknown',
      website: r.recruiters?.companies?.website ?? null,
    }))
  );
});

tpoRouter.patch('/recruiter-requests/:recruiterId', async (req, res) => {
  const { status } = z.object({ status: z.enum(['approved', 'rejected']) }).parse(req.body);
  const recruiterId = z.string().uuid().parse(req.params.recruiterId);
  const collegeId = req.auth!.collegeId!;

  const { data: college } = await supabaseAdmin.from('colleges').select('status').eq('id', collegeId).single();
  if (college?.status !== 'approved') throw new HttpError(403, 'Your college is still awaiting approval');

  const { data, error } = await supabaseAdmin
    .from('college_recruiters')
    .update({ status })
    .eq('college_id', collegeId)
    .eq('recruiter_id', recruiterId)
    .select();
  if (error) throw new HttpError(500, 'Could not update the request');
  if (!data?.length) throw new HttpError(404, 'Request not found');

  res.json({ status });
});


// ---------- Hiring requests and drives for this college ----------

const JOB_COLS =
  'id, title, description, company_id, company_name, company_website, location, job_type, package, apply_by, min_cgpa, max_backlogs, branches, graduation_year, required_skills, test_duration_minutes, pass_percent, creator_role, created_by, open_to_all, is_closed';

const one = (v: any) => (Array.isArray(v) ? v[0] : v);

async function requireApprovedCollege(collegeId: string) {
  const { data } = await supabaseAdmin.from('colleges').select('status').eq('id', collegeId).single();
  if (data?.status !== 'approved') throw new HttpError(403, 'Your college is still awaiting approval');
}

tpoRouter.get('/jobs', async (req, res) => {
  const collegeId = req.auth!.collegeId!;
  const { data, error } = await supabaseAdmin
    .from('job_colleges')
    .select(`status, sent_at, jobs(${JOB_COLS})`)
    .eq('college_id', collegeId)
    .order('sent_at', { ascending: false });
  if (error) throw new HttpError(500, 'Could not load hirings');

  const rows = (data ?? []).filter((r: any) => one(r.jobs));
  if (!rows.length) return res.json([]);

  const jobIds = rows.map((r: any) => one(r.jobs).id as string);
  const creatorIds = [...new Set(rows.map((r: any) => one(r.jobs).created_by as string))];

  const [apps, questions, recruiters] = await Promise.all([
    supabaseAdmin.from('applications').select('job_id, status').eq('college_id', collegeId).in('job_id', jobIds),
    supabaseAdmin.from('job_questions').select('job_id').in('job_id', jobIds),
    supabaseAdmin.from('recruiters').select('user_id, job_title, profiles(full_name)').in('user_id', creatorIds),
  ]);
  if (apps.error || questions.error || recruiters.error) throw new HttpError(500, 'Could not load hirings');

  const funnel = new Map<string, { applicants: number; testPending: number; qualified: number; notQualified: number }>();
  for (const a of apps.data ?? []) {
    const f = funnel.get(a.job_id) ?? { applicants: 0, testPending: 0, qualified: 0, notQualified: 0 };
    f.applicants += 1;
    if (a.status === 'applied') f.testPending += 1;
    else if (a.status === 'not_qualified' || a.status === 'rejected') f.notQualified += 1;
    else f.qualified += 1;
    funnel.set(a.job_id, f);
  }
  const questionCount = new Map<string, number>();
  for (const q of questions.data ?? []) questionCount.set(q.job_id, (questionCount.get(q.job_id) ?? 0) + 1);
  const recruiterById = new Map((recruiters.data ?? []).map((r: any) => [r.user_id, r]));

  // How many hirings from the same company this college has already approved: a simple trust signal.
  const approvedByCompany = new Map<string, number>();
  for (const r of rows as any[]) {
    const j = one(r.jobs);
    if (r.status === 'approved' && j.company_id) approvedByCompany.set(j.company_id, (approvedByCompany.get(j.company_id) ?? 0) + 1);
  }

  res.json(
    (rows as any[]).map((r) => {
      const j = one(r.jobs);
      const rec: any = recruiterById.get(j.created_by);
      return {
        jobId: j.id,
        status: r.status,
        sentAt: r.sent_at,
        title: j.title,
        description: j.description,
        companyName: j.company_name,
        companyWebsite: j.company_website,
        recruiterName: one(rec?.profiles)?.full_name ?? null,
        recruiterTitle: rec?.job_title ?? null,
        pastApproved: j.company_id
          ? (approvedByCompany.get(j.company_id) ?? 0) - (r.status === 'approved' ? 1 : 0)
          : 0,
        isDrive: j.creator_role === 'tpo',
        openToAll: j.open_to_all,
        isClosed: j.is_closed,
        location: j.location,
        jobType: j.job_type,
        package: j.package,
        applyBy: j.apply_by,
        minCgpa: j.min_cgpa,
        maxBacklogs: j.max_backlogs,
        branches: j.branches,
        graduationYear: j.graduation_year,
        requiredSkills: j.required_skills,
        testDurationMinutes: j.test_duration_minutes,
        passPercent: j.pass_percent,
        questionCount: questionCount.get(j.id) ?? 0,
        ...(funnel.get(j.id) ?? { applicants: 0, testPending: 0, qualified: 0, notQualified: 0 }),
      };
    })
  );
});

tpoRouter.patch('/jobs/:jobId', async (req, res) => {
  const { status } = z.object({ status: z.enum(['approved', 'rejected']) }).parse(req.body);
  const jobId = z.string().uuid().parse(req.params.jobId);
  const collegeId = req.auth!.collegeId!;
  await requireApprovedCollege(collegeId);

  // Only a pending request can be decided, and only for this TPO's own college.
  const { data, error } = await supabaseAdmin
    .from('job_colleges')
    .update({ status, decided_at: new Date().toISOString() })
    .eq('job_id', jobId)
    .eq('college_id', collegeId)
    .eq('status', 'pending')
    .select();
  if (error) throw new HttpError(500, 'Could not save your decision');
  if (!data?.length) throw new HttpError(409, 'This request was already decided, or does not exist');
  res.json({ status });
});

tpoRouter.get('/jobs/:jobId/applicants', async (req, res) => {
  const jobId = z.string().uuid().parse(req.params.jobId);
  const collegeId = req.auth!.collegeId!;

  const { data: link } = await supabaseAdmin
    .from('job_colleges')
    .select('job_id')
    .eq('job_id', jobId)
    .eq('college_id', collegeId)
    .maybeSingle();
  if (!link) throw new HttpError(404, 'Hiring not found');

  const { data, error } = await supabaseAdmin
    .from('applications')
    .select(
      'id, match_score, status, applied_at, student_details(roll_no, branch, cgpa, backlogs, profiles(full_name)), test_attempts(percent, passed, submitted_at, terminated)'
    )
    .eq('job_id', jobId)
    .eq('college_id', collegeId)
    .order('applied_at', { ascending: false });
  if (error) throw new HttpError(500, 'Could not load applicants');

  res.json(
    (data ?? []).map((a: any) => {
      const s = one(a.student_details);
      const t = one(a.test_attempts);
      return {
        applicationId: a.id,
        name: one(s?.profiles)?.full_name ?? 'Unknown',
        rollNo: s?.roll_no ?? '',
        branch: s?.branch ?? '',
        cgpa: s?.cgpa ?? null,
        backlogs: s?.backlogs ?? null,
        matchScore: a.match_score,
        status: a.status,
        testPercent: t?.submitted_at ? Number(t.percent) : null,
                terminated: !!t?.terminated,
        appliedAt: a.applied_at,
      };
    })
  );
});

// A college's own drive (internal hiring). openToAll shows it to students of every college.
const driveSchema = jobSchema.extend({
  companyName: z.string().trim().min(2).max(120),
  companyWebsite: z.string().trim().url().optional(),
  openToAll: z.boolean().default(false),
  questions: z.array(questionSchema).min(1).max(50),
});

tpoRouter.post('/drives', async (req, res) => {
  const b = driveSchema.parse(req.body);
  const { userId, collegeId } = req.auth!;
  await requireApprovedCollege(collegeId!);

  const { data: job, error } = await supabaseAdmin
    .from('jobs')
    .insert({
      title: b.title,
      description: b.description,
      company_name: b.companyName,
      company_website: b.companyWebsite ?? null,
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
      creator_role: 'tpo',
      origin_college_id: collegeId,
      open_to_all: b.openToAll,
    })
    .select('id')
    .single();
  if (error || !job) {
    console.error(error);
    throw new HttpError(500, 'Could not create the drive');
  }

  const { error: linkErr } = await supabaseAdmin
    .from('job_colleges')
    .insert({ job_id: job.id, college_id: collegeId, status: 'approved', decided_at: new Date().toISOString() });
  const { error: qErr } = linkErr
    ? { error: linkErr }
    : await supabaseAdmin.from('job_questions').insert(
        b.questions.map((q, i) => ({
          job_id: job.id,
          position: i + 1,
          question: q.question,
          options: q.options,
          correct_index: q.correctIndex,
          source: q.source,
                    category: q.category,
          code_snippet: q.codeSnippet || null,
        }))
      );
  if (linkErr || qErr) {
    console.error(linkErr ?? qErr);
    await supabaseAdmin.from('jobs').delete().eq('id', job.id); // cascades to links and questions
    throw new HttpError(500, 'Could not create the drive');
  }
  res.status(201).json({ id: job.id });
});


// ---------- The college's own profile (shown to recruiters) ----------

const collegeProfileSchema = z.object({
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(80),
  district: z.string().trim().max(80).optional(),
  about: z.string().trim().max(3000).optional(),
  website: z.string().trim().url().optional().or(z.literal('')),
  address: z.string().trim().max(300).optional(),
  establishedYear: z.number().int().min(1800).max(2100).nullable().optional(),
  achievements: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  contactName: z.string().trim().max(100).optional(),
  contactEmail: z.string().trim().email().optional().or(z.literal('')),
  contactPhone: z.string().trim().max(30).optional(),
});

tpoRouter.get('/college-profile', async (req, res) => {
  res.json(await collegeProfile(req.auth!.collegeId!));
});

tpoRouter.put('/college-profile', async (req, res) => {
  const b = collegeProfileSchema.parse(req.body);
  const collegeId = req.auth!.collegeId!;
  const { error } = await supabaseAdmin
    .from('colleges')
    .update({
      city: b.city,
      state: b.state,
      district: b.district || null,
      about: b.about || null,
      website: b.website || null,
      address: b.address || null,
      established_year: b.establishedYear ?? null,
      achievements: b.achievements,
      contact_name: b.contactName || null,
      contact_email: b.contactEmail || null,
      contact_phone: b.contactPhone || null,
    })
    .eq('id', collegeId);
  if (error) throw new HttpError(500, 'Could not save the college profile');
  res.json(await collegeProfile(collegeId));
});

const MAX_COLLEGE_PHOTOS = 8;

tpoRouter.post('/college-photos', imageUpload.single('photo'), async (req, res) => {
  const file = req.file;
  if (!file) throw new HttpError(400, 'Choose an image');
  const kind = imageType(file.buffer);
  if (!kind) throw new HttpError(400, 'Only JPG, PNG or WebP images are accepted');

  const collegeId = req.auth!.collegeId!;
  const { count } = await supabaseAdmin
    .from('college_photos')
    .select('id', { count: 'exact', head: true })
    .eq('college_id', collegeId);
  if ((count ?? 0) >= MAX_COLLEGE_PHOTOS) throw new HttpError(409, `You can add up to ${MAX_COLLEGE_PHOTOS} photos`);

  const path = `${collegeId}/${randomUUID()}.${kind.ext}`;
  const { error: upErr } = await supabaseAdmin.storage
    .from('college-photos')
    .upload(path, file.buffer, { contentType: kind.mime });
  if (upErr) throw new HttpError(500, 'Could not store the photo');

  const { error } = await supabaseAdmin.from('college_photos').insert({ college_id: collegeId, path, position: count ?? 0 });
  if (error) {
    await supabaseAdmin.storage.from('college-photos').remove([path]);
    throw new HttpError(500, 'Could not save the photo');
  }
  res.status(201).json(await collegeProfile(collegeId));
});

tpoRouter.delete('/college-photos/:id', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const collegeId = req.auth!.collegeId!;
  const { data: photo } = await supabaseAdmin
    .from('college_photos')
    .select('id, path')
    .eq('id', id)
    .eq('college_id', collegeId)
    .maybeSingle();
  if (!photo) throw new HttpError(404, 'Photo not found');

  await supabaseAdmin.storage.from('college-photos').remove([photo.path]);
  await supabaseAdmin.from('college_photos').delete().eq('id', id);
  res.json(await collegeProfile(collegeId));
});

// The "See company details" window: what the recruiter filled in about their company.
tpoRouter.get('/jobs/:jobId/company', async (req, res) => {
  const jobId = z.string().uuid().parse(req.params.jobId);
  const { data: link } = await supabaseAdmin
    .from('job_colleges')
    .select('job_id')
    .eq('job_id', jobId)
    .eq('college_id', req.auth!.collegeId!)
    .maybeSingle();
  if (!link) throw new HttpError(404, 'Hiring not found');

  const { data: job } = await supabaseAdmin.from('jobs').select('company_id, created_by').eq('id', jobId).single();
  if (!job?.company_id) throw new HttpError(404, 'No company details for this hiring');

  const [company, rec] = await Promise.all([
    companyProfile(job.company_id),
    supabaseAdmin.from('recruiters').select('job_title, profiles(full_name)').eq('user_id', job.created_by).maybeSingle(),
  ]);
  const r: any = rec.data;
  res.json({
    company,
    contact: { name: one(r?.profiles)?.full_name ?? null, title: r?.job_title ?? null },
  });
});


// ---------- Students of this college ----------

tpoRouter.get('/students', async (req, res) => {
  const collegeId = req.auth!.collegeId!;
  const [students, apps] = await Promise.all([
    supabaseAdmin
      .from('student_details')
      .select('user_id, roll_no, branch, graduation_year, cgpa, backlogs, resume_path, parsed_skills, profiles(full_name)')
      .eq('college_id', collegeId)
      .order('roll_no'),
    supabaseAdmin
      .from('applications')
      .select('student_id, job_id, status, match_score, test_attempts(percent, passed, submitted_at, terminated)')
      .eq('college_id', collegeId),
  ]);
  if (students.error || apps.error) throw new HttpError(500, 'Could not load students');

  const byStudent = new Map<string, any[]>();
  for (const a of apps.data ?? []) {
    const t = one((a as any).test_attempts);
    const list = byStudent.get(a.student_id) ?? [];
    list.push({
      jobId: a.job_id,
      status: a.status,
      matchScore: a.match_score,
      testTaken: !!t?.submitted_at && !t?.terminated,
      testPercent: t?.submitted_at ? Number(t.percent) : null,
      passed: t?.submitted_at ? !!t.passed : null,
      terminated: !!t?.terminated,
    });
    byStudent.set(a.student_id, list);
  }

  res.json({
    students: (students.data ?? []).map((s: any) => ({
      userId: s.user_id,
      name: one(s.profiles)?.full_name ?? 'Unknown',
      rollNo: s.roll_no,
      branch: s.branch,
      graduationYear: s.graduation_year,
      cgpa: s.cgpa,
      backlogs: s.backlogs,
      hasResume: !!s.resume_path,
      skillsCount: Array.isArray(s.parsed_skills) ? s.parsed_skills.length : 0,
      applications: byStudent.get(s.user_id) ?? [],
    })),
  });
});

// One student's full profile. A TPO can only open students of their own college.
tpoRouter.get('/students/:id', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const collegeId = req.auth!.collegeId!;

  const { data: s } = await supabaseAdmin
    .from('student_details')
    .select(
      'user_id, roll_no, branch, graduation_year, cgpa, backlogs, github_url, linkedin_url, avatar_path, resume_path, parsed_skills, profiles(full_name)'
    )
    .eq('user_id', id)
    .eq('college_id', collegeId)
    .maybeSingle();
  if (!s) throw new HttpError(404, 'Student not found');
  const st: any = s;

  const [user, apps, avatar, resume] = await Promise.all([
    supabaseAdmin.auth.admin.getUserById(id),
    supabaseAdmin
      .from('applications')
      .select('status, match_score, applied_at, jobs(title, company_name, pass_percent), test_attempts(percent, passed, submitted_at, terminated)')
      .eq('student_id', id)
      .order('applied_at', { ascending: false }),
    st.avatar_path ? supabaseAdmin.storage.from('avatars').createSignedUrl(st.avatar_path, 3600) : null,
    st.resume_path ? supabaseAdmin.storage.from('resumes').createSignedUrl(st.resume_path, 300) : null,
  ]);

  res.json({
    userId: st.user_id,
    name: one(st.profiles)?.full_name ?? 'Unknown',
    email: user.data.user?.email ?? null,
    rollNo: st.roll_no,
    branch: st.branch,
    graduationYear: st.graduation_year,
    cgpa: st.cgpa,
    backlogs: st.backlogs,
    githubUrl: st.github_url,
    linkedinUrl: st.linkedin_url,
    avatarUrl: avatar?.data?.signedUrl ?? null,
    resumeUrl: resume?.data?.signedUrl ?? null,
    skills: Array.isArray(st.parsed_skills) ? st.parsed_skills : [],
    applications: (apps.data ?? []).map((a: any) => {
      const job = one(a.jobs);
      const t = one(a.test_attempts);
      return {
        title: job?.title ?? 'Job',
        company: job?.company_name ?? '',
        status: a.status,
        matchScore: a.match_score,
        appliedAt: a.applied_at,
        testPercent: t?.submitted_at ? Number(t.percent) : null,
        passPercent: job?.pass_percent ?? null,
        terminated: !!t?.terminated,
      };
    }),
  });
});