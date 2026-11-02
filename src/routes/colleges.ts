import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { HttpError } from '../lib/errors';

export const collegesRouter = Router();

// Public: approved colleges only, optional ?q= search by name
collegesRouter.get('/', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
  let query = supabaseAdmin
    .from('colleges')
    .select('id, name, city, state, email_domain')
    .eq('status', 'approved')
    .order('name')
    .limit(50);
  if (q) query = query.ilike('name', `%${q}%`);

  const { data, error } = await query;
  if (error) throw new HttpError(500, 'Could not load colleges');
  res.json(data);
});