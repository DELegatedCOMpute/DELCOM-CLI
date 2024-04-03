import readline from 'node:readline/promises';
import dotenv from 'dotenv';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {io} from 'socket.io-client';
import {spawn} from 'child_process';

const outputNames = [
  'build_std_out',
  'build_std_err',
  'run_std_out',
  'run_std_err',
];

// function getRandElement<T>(arr:T[]) {
const getRandElement = (arr) => {
  if (arr.length == 0) {
    return undefined;
  }
  return arr[Math.floor(Math.random() * arr.length)];
};

const delcomPath = path.join(os.tmpdir(), 'DELCOM');
if (!fs.existsSync(delcomPath)) {
  console.warn(`${delcomPath} not detected, making...`);
  await fsp.mkdir(delcomPath);
}

dotenv.config();

const config = {
  isWorking: false, // update before async
  jobDir: undefined, // location of Dockerfiles and dependencies
  jobWriteStreams: {},
  resultDir: undefined, // location of the output of a dispatched job
  resultWriteStreams: {},
};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const helpMessage = () => {
  // console.clear();
  return `\nOptions: \n\
\tj join:  \tJoin the worker network\n\
\tl leave: \tLeave the working network\n\
\tq quit:  \tQuit the application\n\
\tn new:   \tCreate a new job\n\
\tc clear: \tClear the console\n\
Status:\n\
\tCurrently in worker network:\t${config.isWorker}\n\
`;
};

const ip = process.env.IP || await rl.question('Connection ip:');
// 0 is falsy, can't parse undefined
const port = parseInt(process.env.PORT || '0') ||
              await rl.question('Connection port:');
const addr = `http://${ip}:${port}`;
const socket = io(addr);

const setupResDir = async (dir) => {
  if (!dir) {
    dir = await fsp.mkdtemp(`${delcomPath}${path.sep}res`);
  }
  config.resultDir = dir;
  for (const outputName of outputNames) {
    config.resultWriteStreams[outputName] = fs.createWriteStream(
        `${config.resultDir}${path.sep}${outputName}`,
    );
  }
};

const sendFiles = async (filePaths) => {
  try {
    const fileClosedPromises = filePaths.map(async (filePath) => {
      const name = path.basename(filePath);
      const readStream = fs.createReadStream(filePath, {encoding: 'base64'});
      readStream.on('data', async (chunk) => {
        await socket.emitWithAck('send_file_data', {name, chunk});
      });
      return new Promise((resolve, reject) => {
        readStream.on('close', () => {
          if (readStream.errored) {
            reject(Error `readStream for ${name} errored`);
          }
          resolve();
        });
      });
    });
    await Promise.all(fileClosedPromises);
    console.log('files done sending');
    socket.emit('files_done_sending');
  } catch (err) {
    // TODO reset config state on error
    console.error('Failed to send files');
    console.error(err);
  }
};

socket.on('receive_file_data', async ({name, chunk}) => {
  try {
    console.log(`Writing ${chunk} to ${
      config.jobDir}${path.sep}${name}`);
    await fs.createWriteStream(
        `${config.jobDir}${path.sep}${name}`,
        {encoding: 'base64'},
    ).write(chunk);
  } catch (err) {
    // TODO handle
    console.error('Failed to receive files');
    console.error(err);
  }
});

for (const outputName of outputNames) {
  socket.on(outputName, async (chunk) => {
    try {
      console.log(outputName, chunk);
      const ws = config.resultWriteStreams[outputName];
      if (!ws) {
        console.error(`No write stream for ${outputName}!`);
        return;
      }
      if (ws instanceof fs.WriteStream) {
        ws.write(chunk);
      }
    } catch (err) {
      // TODO handle
    }
  });
}

const build = async () => {
  return new Promise(async (res, rej) => {
    try {
      // const writeStreamClose = Object.values(config.jobWriteStreams)
      //     .map(async (ws) => {
      //       await promisify(ws.end)();
      //     });
      // await Promise.all(writeStreamClose);
      console.log(config.jobWriteStreams);
      const workingDir = config.jobDir;
      const dockerName = path.basename(workingDir).toLowerCase();
      const build = spawn(
          'docker',
          ['build', `-t${dockerName}`, '--progress=plain', workingDir],
      );
      build.stdout.on('data', (chunk) => {
        socket.emit('build_std_out', chunk);
      });
      build.stderr.on('data', (chunk) => {
        socket.emit('build_std_err', chunk);
      });
      build.on('close', (code) => {
        if (code) {
          rej(Error `Build failed with code ${code}`);
        } else {
          res({workingDir, dockerName});
        }
      });
    } catch (err) {
      console.log(err);
      rej(err);
    }
  });
};

const run = async () => {
  return new Promise((res, rej) => {
    try {
      const dockerName = path.basename(workingDir).toLowerCase();
      const build = spawn(
          'docker',
          ['run', dockerName],
      );
      build.stdout.on('data', (chunk) => {
        socket.emit('run_std_out', chunk);
      });
      build.stderr.on('data', (chunk) => {
        socket.emit('run_std_err', chunk);
      });
      build.on('close', (code) => {
        if (code) {
          rej(Error `Runtime failed with code ${code}`);
        } else {
          res();
        }
      });
    } catch (err) {
      rej(err);
    }
  });
};

socket.on('start', async () => {
  try {
    console.log(`starting job ${config.jobDir}`);
    await build();
    console.log('built job, running');
    await run();
    console.log('finished job');
    socket.emit('done');
  } catch (err) {
    // TODO handle err
  }
});

socket.on('finished', () => {
  // TODO
  console.log(`Job completed! Files are at ${config.resultDir}`);
  config.isWorking = false;
  config.resultDir = undefined;
});

const askForFilePaths = async () => {
  const filePaths = [];
  let filePath;
  let lstat;
  while (!lstat || !lstat.isFile() || !filePath.endsWith('Dockerfile')) {
    filePath = await rl.question('Please input dockerfile location: ');
    try {
      lstat = await fsp.lstat(filePath);
    } catch (err) {
      console.error(`No such file or directory: ${filePath}`);
    }
    if (!filePath.endsWith('Dockerfile')) {
      console.error('File must be named "Dockerfile"');
    }
  }
  filePaths.push(filePath);
  while (filePath) {
    filePath = await rl.question('Input dependency file location ' +
                                 '[or blank to continue]: ');
    try {
      lstat = await fsp.lstat(filePath);
      if (lstat.isFile()) {
        filePaths.push(filePath);
      } else {
        console.error('Must be a file!');
      }
    } catch (err) {
      if (filePath) {
        console.error(`No such file or directory: ${filePath}`);
      }
    }
  }
  return filePaths;
};

socket.on('connect', async () => {
  console.log('connected');
  while (!socket.disconnected) {
    const input = await rl.question(helpMessage());
    if (input == 'j' || input == 'join') {
      config.isWorker = true;
      socket.emit('join');
    } else if (input == 'l' || input == 'leave') {
      config.isWorker = false;
      socket.emit('leave');
    } else if (input == 'q' || input == 'quit') {
      socket.close();
      rl.close();
    } else if (input == 'n' || input == 'new') {
      try {
        await setupResDir();
        const workers = await socket.emitWithAck('get_workers');
        const worker = getRandElement(workers);
        console.log(worker);
        const req = await socket.emitWithAck('request_worker', worker.id);
        if (!req?.err) {
          const filePaths = await askForFilePaths();
          await sendFiles(filePaths);
        } else {
          console.log(req?.err);
        }
      } catch (err) {
        console.error(err);
        console.error('err in new job routine');
      }
    } else if (input == 'c' || input == 'clear') {
      console.clear();
    }
  }
});

socket.on('new_job', async (callback) => {
  try {
    console.log('Job requested, preparing...');
    if (config.isWorking) {
      console.warn('Job request rejected, aborting');
      callback({err: 'Already working'});
      return;
    }
    config.isWorking = true;
    config.jobDir = await fsp.mkdtemp(`${delcomPath}${path.sep}job`);
    console.log(`Job files will be stored at ${config.jobDir}`);
    callback({});
  } catch (err) {
    config.isWorking = false;
    config.jobDir = undefined;
    console.error('Error when setting up new job');
    console.error(err);
    callback({err: 'Failed to make directory'});
  }
});

socket.on('get_config', (callback) => {
  callback(config);
});

socket.on('disconnect', (reason) => {
  console.log(`Disconnected: ${reason}`);
});
