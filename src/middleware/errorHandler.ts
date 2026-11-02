import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../lib/errors';
import multer from 'multer';

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof ZodError) {
        res.status(400).json({
            error: 'Validation failed',
            details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        });
        return;
    }
    if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
    }
    if (err?.type === 'entity.parse.failed') {
        res.status(400).json({ error: 'Invalid JSON body' });
        return;
    }

    if (err instanceof multer.MulterError) {
        res.status(400).json({
            error: err.code === 'LIMIT_FILE_SIZE' ? 'Resume must be 5 MB or smaller' : 'Upload failed',
        });
        return;
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
};

