import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';

const router = Router();

router.get('/', (_req, res) => {
  res.json({ status: 'ok' });
});

router.get('/db', async (_req, res) => {
  const { error } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1 });
  if (error) return res.status(500).json({ status: 'error', message: error.message });
  res.json({ status: 'connected' });
});

export default router;