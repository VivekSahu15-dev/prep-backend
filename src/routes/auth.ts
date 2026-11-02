import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { supabaseAdmin } from '../lib/supabase';
import { HttpError } from '../lib/errors';
import { BRANCHES } from '../lib/constants';
import { domainOf, emailMatchesCollege, isPublicDomain } from '../lib/emailDomain';
import { requireAuth } from '../middleware/auth';

export const authRouter = Router();

const email = z.string().trim().toLowerCase().email();
const password = z.string().min(8, 'Password must be at least 8 characters');
const fullName = z.string().trim().min(2).max(100);

async function createAuthUser(emailAddr: string, pwd: string, role: string, name: string) {
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email: emailAddr,
    password: pwd,
    email_confirm: true,
    app_metadata: { role },
    user_metadata: { full_name: name },
  });
  if (error || !data.user) {
    if (error?.code === 'email_exists' || /already|registered/i.test(error?.message ?? '')) {
      throw new HttpError(409, 'An account with this email already exists');
    }
    throw new HttpError(400, error?.message ?? 'Could not create account');
  }
  return data.user.id;
}

// Deleting the user cascades to profile/student/recruiter rows. The college goes after,
// because profiles.college_id points at it.
async function rollback(userId: string, collegeId?: string) {
  await supabaseAdmin.auth.admin.deleteUser(userId);
  if (collegeId) await supabaseAdmin.from('colleges').delete().eq('id', collegeId);
}

function requireOfficialEmail(address: string) {
  if (!env.ALLOW_PUBLIC_EMAIL_DOMAINS && isPublicDomain(domainOf(address))) {
    throw new HttpError(400, 'Use your official college or company email address');
  }
}

// ---------- TPO: registers a college ----------
authRouter.post('/register/tpo', async (req, res) => {
  const body = z
    .object({
      fullName,
      email,
      password,
      college: z.object({
        name: z.string().trim().min(3).max(150),
        city: z.string().trim().min(2).max(80),
        state: z.string().trim().min(2).max(80),
        emailDomain: z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'Enter a valid domain like srmist.edu.in'),
      }),
    })
    .parse(req.body);

  requireOfficialEmail(body.email);
  if (!emailMatchesCollege(body.email, body.college.emailDomain)) {
    throw new HttpError(400, `Your email must end with @${body.college.emailDomain}`);
  }

  const userId = await createAuthUser(body.email, body.password, 'tpo', body.fullName);

  const { data: college, error: cErr } = await supabaseAdmin
    .from('colleges')
    .insert({
      name: body.college.name,
      city: body.college.city,
      state: body.college.state,
      email_domain: body.college.emailDomain,
    })
    .select('id')
    .single();
  if (cErr || !college) {
    await rollback(userId);
    if (cErr?.code === '23505') throw new HttpError(409, 'A college with this email domain is already registered');
    throw new HttpError(500, 'Could not register the college');
  }

  const { error: pErr } = await supabaseAdmin.from('profiles').insert({
    user_id: userId,
    role: 'tpo',
    full_name: body.fullName,
    college_id: college.id,
  });
  if (pErr) {
    await rollback(userId, college.id);
    throw new HttpError(500, 'Could not create your profile');
  }

  res.status(201).json({ message: 'College submitted for approval', collegeStatus: 'pending' });
});

// ---------- Student: joins an approved college ----------
authRouter.post('/register/student', async (req, res) => {
  const year = new Date().getFullYear();
  const body = z
    .object({
      fullName,
      email,
      password,
      collegeId: z.string().uuid(),
      rollNo: z.string().trim().min(1).max(30),
      branch: z.enum(BRANCHES),
      graduationYear: z.coerce.number().int().min(year).max(year + 6),
    })
    .parse(req.body);

  const { data: college } = await supabaseAdmin
    .from('colleges')
    .select('id, email_domain, status')
    .eq('id', body.collegeId)
    .maybeSingle();
  if (!college || college.status !== 'approved') throw new HttpError(404, 'College not found');
  if (!emailMatchesCollege(body.email, college.email_domain)) {
    throw new HttpError(400, `Use your college email ending with @${college.email_domain}`);
  }

  const userId = await createAuthUser(body.email, body.password, 'student', body.fullName);

  const { error: pErr } = await supabaseAdmin.from('profiles').insert({
    user_id: userId,
    role: 'student',
    full_name: body.fullName,
    college_id: college.id,
  });
  if (pErr) {
    await rollback(userId);
    throw new HttpError(500, 'Could not create your profile');
  }

  const { error: sErr } = await supabaseAdmin.from('student_details').insert({
    user_id: userId,
    college_id: college.id,
    roll_no: body.rollNo.toUpperCase(),
    branch: body.branch,
    graduation_year: body.graduationYear,
  });
  if (sErr) {
    await rollback(userId);
    if (sErr.code === '23505') throw new HttpError(409, 'This roll number is already registered at your college');
    throw new HttpError(500, 'Could not save your student details');
  }

  res.status(201).json({ message: 'Account created' });
});

// ---------- Recruiter: belongs to a company, not a college ----------
authRouter.post('/register/recruiter', async (req, res) => {
  const body = z
    .object({
      fullName,
      email,
      password,
      companyName: z.string().trim().min(2).max(120),
      companyWebsite: z.string().trim().url().optional(),
      jobTitle: z.string().trim().min(2).max(80),
    })
    .parse(req.body);

  requireOfficialEmail(body.email);

  const userId = await createAuthUser(body.email, body.password, 'recruiter', body.fullName);

  const nameKey = body.companyName.toLowerCase().replace(/\s+/g, ' ');
  const { data: existing } = await supabaseAdmin
    .from('companies')
    .select('id')
    .eq('name_key', nameKey)
    .maybeSingle();

  let companyId = existing?.id as string | undefined;
  if (!companyId) {
    const { data: created, error: coErr } = await supabaseAdmin
      .from('companies')
      .insert({ name: body.companyName, name_key: nameKey, website: body.companyWebsite ?? null })
      .select('id')
      .single();
    if (coErr || !created) {
      await rollback(userId);
      throw new HttpError(500, 'Could not save your company');
    }
    companyId = created.id;
  }

  const { error: pErr } = await supabaseAdmin
    .from('profiles')
    .insert({ user_id: userId, role: 'recruiter', full_name: body.fullName });
  const { error: rErr } = pErr
    ? { error: pErr }
    : await supabaseAdmin
        .from('recruiters')
        .insert({ user_id: userId, company_id: companyId, job_title: body.jobTitle });
  if (pErr || rErr) {
    await rollback(userId);
    throw new HttpError(500, 'Could not create your profile');
  }

  res.status(201).json({ message: 'Account created' });
});

// ---------- Who am I ----------
authRouter.get('/me', requireAuth, async (req, res) => {
  const { userId, email: userEmail, role, collegeId } = req.auth!;

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('full_name')
    .eq('user_id', userId)
    .single();

  const college = collegeId
    ? (
        await supabaseAdmin
          .from('colleges')
          .select('id, name, city, state, email_domain, status')
          .eq('id', collegeId)
          .single()
      ).data
    : null;

  let details: unknown = null;
  if (role === 'student') {
    details = (
      await supabaseAdmin
        .from('student_details')
        .select('roll_no, branch, graduation_year')
        .eq('user_id', userId)
        .single()
    ).data;
  } else if (role === 'recruiter') {
    details = (
      await supabaseAdmin
        .from('recruiters')
        .select('job_title, companies(name, website)')
        .eq('user_id', userId)
        .single()
    ).data;
  }

  res.json({ userId, email: userEmail, fullName: profile?.full_name ?? '', role, college, details });
});