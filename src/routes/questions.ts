import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { HttpError } from '../lib/errors';
import { generateQuestions, parseQuestionsPdf } from '../lib/aiService';
import { requireAuth, requireRole } from '../middleware/auth';

// Tools for building a test. Recruiters and placement officers both use them, and nothing here is saved:
// the questions go back to the screen to be reviewed first.
export const questionsRouter = Router();
questionsRouter.use(requireAuth, requireRole('recruiter', 'tpo'));

const pdfUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

questionsRouter.post('/parse-pdf', pdfUpload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) throw new HttpError(400, 'Choose a PDF file');
  if (file.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw new HttpError(400, 'Only PDF files are accepted');

  const r = await parseQuestionsPdf(file.buffer);
  if (!r.ok) throw new HttpError(r.status, r.message);
  res.json({ questions: r.questions, skipped: r.skipped });
});

const generateSchema = z
  .object({
    topic: z.string().trim().min(3).max(200),
    skills: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
    difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'),
    technical: z.number().int().min(0).max(15).default(0),
    aptitude: z.number().int().min(0).max(15).default(0),
    coding: z.number().int().min(0).max(15).default(0),
  })
  .refine((v) => v.technical + v.aptitude + v.coding >= 1 && v.technical + v.aptitude + v.coding <= 20, {
    message: 'Ask for between 1 and 20 questions in total',
    path: ['technical'],
  });

questionsRouter.post('/generate', async (req, res) => {
  const input = generateSchema.parse(req.body);
  const r = await generateQuestions(input);
  if (!r.ok) throw new HttpError(r.status, r.message);
  res.json({ questions: r.questions, dropped: r.dropped });
});