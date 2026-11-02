import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env';
import health from './routes/health';
import { authRouter } from './routes/auth';
import { collegesRouter } from './routes/colleges';
import { recruiterRouter } from './routes/recruiter';
import { tpoRouter } from './routes/tpo';
import { studentRouter } from './routes/student';
import { errorHandler } from './middleware/errorHandler';
import { questionsRouter } from './routes/questions';

export const app = express();

app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGIN.split(',') }));
app.use(express.json());

app.use('/health', health);
app.use('/auth', authRouter);
app.use('/colleges', collegesRouter);
app.use('/recruiter', recruiterRouter);
app.use('/tpo', tpoRouter);
app.use('/student', studentRouter);
app.use('/questions', questionsRouter);

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use(errorHandler);