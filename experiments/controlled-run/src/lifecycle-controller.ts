import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let supervisor: ChildProcess | undefined;
process.on('message', (message: { type: string }) => {
  if (message.type === 'start' && !supervisor) {
    supervisor = fork(fileURLToPath(new URL('./lifecycle-supervisor.js', import.meta.url)), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], detached: true });
    supervisor.stderr?.on('data', () => {});
    supervisor.on('message', event => { if (process.connected) process.send?.(event); });
    supervisor.on('exit', (code, signal) => {
      if (process.connected) { process.send?.({ type: 'supervisor-exit', code, signal }); process.disconnect(); }
    });
    supervisor.send(message);
  } else if (message.type === 'stop' && supervisor?.connected) supervisor.send(message);
});
process.on('disconnect', () => { if (supervisor?.connected) supervisor.disconnect(); });
