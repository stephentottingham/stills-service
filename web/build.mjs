// Builds the library screens into web/dist (served by CloudFront from the web bucket).
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
cpSync('public', 'dist', { recursive: true });
cpSync('src/index.html', 'dist/index.html');
cpSync('src/app.css', 'dist/app.css');

const options = {
  entryPoints: { app: 'src/main.ts', 'render-worker': 'src/render-worker.ts' },
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: !watch,
  sourcemap: true,
  outdir: 'dist',
};
if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('Watching web/src');
} else {
  await esbuild.build(options);
  console.log('Built web/dist');
}
