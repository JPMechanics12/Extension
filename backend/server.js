import express from 'express';
import path from 'path';
import cors from 'cors';
import morgan from 'morgan';
import { fileURLToPath } from 'url';
import apiRouter from './src/routes/api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

app.use('/api', apiRouter);

// Serve frontend
app.use('/', express.static(path.join(__dirname, '../')));

const PORT = process.env.PORT || 4001;
app.listen(PORT, () => {
  console.log(`API + front-end on http://0.0.0.0:${PORT}`);
});
