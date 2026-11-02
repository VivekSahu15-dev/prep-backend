import type { RequestHandler } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { HttpError } from '../lib/errors';

export type Role = 'tpo' | 'student' | 'recruiter';

export const requireAuth: RequestHandler = async (req, _res, next) => {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw new HttpError(401, 'Sign in required');

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, 'Session expired. Please sign in again');

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('role, college_id')
    .eq('user_id', data.user.id)
    .maybeSingle();
  if (!profile) throw new HttpError(403, 'Account setup is incomplete');

  req.auth = {
    userId: data.user.id,
    email: data.user.email ?? '',
    role: profile.role as Role,
    collegeId: profile.college_id,
  };
  next();
};

export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      throw new HttpError(403, 'You do not have access to this');
    }
    next();
  };