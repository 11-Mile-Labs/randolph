import { Journal } from './evidence.js';
import { retainedRunState } from './lifecycle.js';

if (!process.argv[2]) throw new Error('Retained journal directory required');
process.stdout.write(retainedRunState(new Journal(process.argv[2])) + '\n');
