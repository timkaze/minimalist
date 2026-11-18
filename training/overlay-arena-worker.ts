// overlay-arena.ts の runJobs から呼ばれる．環境変数 OV_JOB（JSON）の仕事を回し，記録を標準出力へ JSON で出す
import { Job, runJob } from './overlay-arena';

const job = JSON.parse(process.env.OV_JOB ?? 'null') as Job | null;
if (!job) throw new Error('OV_JOB がありません');
process.stdout.write(JSON.stringify(runJob(job)));
