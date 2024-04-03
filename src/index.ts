import readline from 'node:readline/promises';
import dotenv from 'dotenv';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {io, Socket} from 'socket.io-client';
import {spawn} from 'child_process';

const outputNames = [
  'build_std_out',
  'build_std_err',
  'run_std_out',
  'run_std_err',
];

type clientListElement = {
  id: string,
}

function getRandElement<T>(arr:T[]) {
  if (arr.length == 0) {
    return undefined;
  }
  return arr[Math.floor(Math.random() * arr.length)];
};

dotenv.config();

type jobInfoType = {
  dir: string,
  writeStreams: {[key: string]: fs.WriteStream},
};

type resultInfoType = {
  dir: string,
  writeStreams: {[key: string]: fs.WriteStream}
}

type configType = {
  isWorking: boolean,
  isWorker: boolean,
  id?: string,
  job?: jobInfoType,
  res?: resultInfoType
}

const config : configType = {
  isWorking: false, // update before async
  isWorker: false, // if registered as worker
  id: undefined
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

const delcomPath = path.join(os.tmpdir(), 'DELCOM');
if (!fs.existsSync(delcomPath)) {
  console.warn(`${delcomPath} not detected, making...`);
  await fsp.mkdir(delcomPath);
}

const ip = process.env.IP || await rl.question('Connection ip:');
// 0 is falsy, can't parse undefined
const port = parseInt(process.env.PORT || '0') ||
              await rl.question('Connection port:');
const addr = `http://${ip}:${port}`;
const socket = io(addr);

async function setupResDir(dir?: string) {
  if (config.res) {
    return Error("Result directory exists!");
  }
  if (!dir) {
    dir = await fsp.mkdtemp(`${delcomPath}${path.sep}res`);
  }
  config.res = {
    dir,
    writeStreams: {},
  };
  for (const outputName of outputNames) {
    config.res.writeStreams[outputName] = fs.createWriteStream(
        `${config.res.dir}${path.sep}${outputName}`,
    );
  }
};

async function sendFiles (socket: Socket, filePaths: string[]) {
  return filePaths.map(async (filePath) => {
    const name = path.basename(filePath);
    const readStream = fs.createReadStream(filePath, {encoding: 'base64'});
    readStream.on('data', async (chunk) => {
      await socket.emitWithAck('send_file_data', {name, chunk});
    });
    return new Promise<void>((resolve, reject) => {
      readStream.on('close', () => {
        if (readStream.errored) {
          reject(Error(`readStream for ${name} errored`));
        }
        console.log('files done sending');
        socket.emit('files_done_sending');
        resolve();
      });
    });
  });
};

socket.on('receive_file_data', ({name, chunk}) => {
  if (!config.job) {
    return Error('No job setup to write to!');
  }
  console.log(`Writing ${chunk} to ${config.job}${path.sep}${name}`);
  fs.createWriteStream(
      `${config.job.dir}${path.sep}${name}`,
      {encoding: 'base64'},
  ).write(chunk);
});

for (const outputName of outputNames) {
  socket.on(outputName, async (chunk) => {
    if (!config.res) {
      return Error('No res setup to write to!')
    }
    console.log(outputName, chunk);
    const ws = config.res.writeStreams[outputName];
    if (!ws) {
      console.error(`No write stream for ${outputName}!`);
      return;
    }
    ws.write(chunk);
  });
}

async function build() {
  return new Promise<void>(async (res, rej) => {
    if (!config.job?.dir) {
      rej('No job dir to build from!');
      return;
    }
    console.log(config.job.writeStreams);
    const workingDir = config.job.dir;
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
        rej(`Build failed with code ${code}`);
      } else {
        res();
      }
    });
  });
};

function run() {
  return new Promise<void>((res, rej) => {
    if (!config.job?.dir) {
      rej('No job dir to build from!');
      return;
    }
    const workingDir = config.job.dir;
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
        rej(`Runtime failed with code ${code}`);
      } else {
        res();
      }
    });
  });
};

socket.on('start', async () => {
  if (!config.job) {
    return Error("No job to start!");
  }
  console.log(`starting job ${config.job.dir}`);
  await build();
  console.log('built job, running');
  await run();
  console.log('finished job');
  socket.emit('done');
});

socket.on('finished', () => {
  if (!config.res) {
    return Error("Job finished with no results! (impossible?)");
  }
  console.log(`Job completed! Files are at ${config.res.dir}`);
  config.isWorking = false;
  config.res = undefined;
});

async function askForFilePaths() {
  const filePaths = [];
  let filePath;
  let lstat;
  while (!lstat || !lstat.isFile() || !filePath?.endsWith('Dockerfile')) {
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
        const workers : clientListElement[] = await socket.emitWithAck('get_workers');
        const worker = getRandElement(workers);
        if (!worker) {
          console.warn('Unable to choose worker!');
          continue;
        }
        const req = await socket.emitWithAck('request_worker', worker.id);
        if (!req?.err) {
          const filePaths = await askForFilePaths();
          await sendFiles(socket, filePaths);
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
  if (config.job) {
    return Error('No job dir on new j!');
  }
  console.log('Job requested, preparing...');
  if (config.isWorking) {
    console.warn('Job request rejected, aborting');
    callback({err: 'Already working'});
    return;
  }
  config.isWorking = true;
  config.job = {
    dir: await fsp.mkdtemp(`${delcomPath}${path.sep}job`),
    writeStreams: {},
  };
  console.log(`Job files will be stored at ${config.job.dir}`);
  callback({});
});

socket.on('get_config', (callback) => {
  callback(config);
});

socket.on('disconnect', (reason) => {
  console.log(`Disconnected: ${reason}`);
});
