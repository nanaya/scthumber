import 'colors';
import cluster from 'cluster';
import express from 'express';
import os from 'os';
import gracefulShutdown from 'http-graceful-shutdown';
import scThumber from './lib/scthumber.js';

const thumber = scThumber({
  presets: {
    // Beatmap cover
    // 900x250 (1800x500 @2x)
    'cover': {
      width: 900,
      height: 250,
    },
    'cover@2x': {
      width: 900,
      height: 250,
      pixelScale: 2
    },
    // New slimmer beatmap cover
    // 1920x360 (3840x720 @2x)
    'slimcover': {
      width: 1920,
      height: 360,
    },
    'slimcover@2x': {
      width: 1920,
      height: 360,
      pixelScale: 2
    },
    // Beatmap card thumbnail
    // 400x140 (800x280 @2x)
    'card': {
      width: 400,
      height: 140
    },
    'card@2x': {
      width: 400,
      height: 140,
      pixelScale: 2
    },
    // Beatmap list thumbnail
    // 150x150 (300x300 @2x)
    'list': {
      width: 150,
      height: 150
    },
    'list@2x': {
      width: 150,
      height: 150,
      pixelScale: 2
    },
  }
});

const workers = process.env.WORKERS ?? os.cpus().length;
const port = process.env.PORT ?? 4001;

if (cluster.isPrimary) {
  console.log(`${'[m]'.red} ${'scthumbd'.yellow}`);
  console.log(`${'[m]'.red} Listening on port ${'%s'.green}...`, port);
}

if (cluster.isPrimary && workers > 1) {
  console.log(`${'[m]'.red} Starting ${'%s'.green} workers...`, workers);
  for (let i = 0; i < workers; i++) {
    cluster.fork();
  }

  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (!shuttingDown) {
        shuttingDown = true;
        for (const worker of Object.values(cluster.workers)) {
          worker.kill(signal);
        }
      }
    });
  }

  cluster.on('exit', (worker, code, signal) => {
    if (shuttingDown) {
      console.log(`${'[m]'.red} worker ${worker.id} stopped`);
    } else {
      console.log(`${'[m]'.red} worker ${worker.id} died, restarting`);
      cluster.fork();
    }
  });
} else {
  const app = express();

  app.get('/', function(req, res) {
    res.send("scthumbd\n");
  });
  app.get('/thumb/*', thumber.thumbnail);
  app.get('/optim/*', thumber.optimize);

  const server = app.listen(port);

  gracefulShutdown(server);

  console.log(`${'[w]'.magenta} Worker ${'%s'.green} started...`, cluster.worker?.id ?? 1);
}
