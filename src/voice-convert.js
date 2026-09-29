import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function withConvertedVoice(sourcePath, send) {
  const directory = await mkdtemp(join(tmpdir(), 'smj-voice-'));
  const inputPath = join(directory, 'voice.ogg');
  const outputPath = join(directory, 'voice.m4a');
  try {
    await copyFile(sourcePath, inputPath);
    await new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error',
        '-i', inputPath, '-vn', '-ac', '1', '-c:a', 'aac', '-b:a', '64k', outputPath],
      { stdio: 'ignore' });
      ffmpeg.once('error', reject);
      ffmpeg.once('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`)));
    });
    if ((await stat(outputPath)).size === 0) throw new Error('Converted voice is empty');
    return await send(outputPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
