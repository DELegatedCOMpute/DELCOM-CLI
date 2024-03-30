import readline from 'node:readline/promises';
import dotenv from 'dotenv';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {io} from 'socket.io-client';
import {spawn} from 'child_process';

dotenv.config();

const config = {
  joined: false,
  working: false,
};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const helper = ()=>{
  // console.clear();
  return `\nOptions: \n\
\tj join:  \tJoin the worker network\n\
\tl leave: \tLeave the working network\n\
\tq quit:  \tQuit the application\n\
\tn new:   \tCreate a new job\n\
\tc clear: \tClear the console\n\
Status:\n\
\tCurrently in worker network:\t${config.joined}\n\
`;
};

const ip = process.env.IP || await rl.question('Connection ip:');
// 0 is falsy, can't parse undefined
const port = parseInt(process.env.PORT || '0') ||
              await rl.question('Connection port:');
const addr = `http://${ip}:${port}`;
const socket = io(addr);

socket.on('connect', async () => {
  console.log('connected');
  while (!socket.disconnected) {
    const input = await rl.question(helper());
    if (input == 'j' || input == 'join') {
      config.joined = true;
      socket.emit('join');
    } else if (input == 'l' || input == 'leave') {
      config.joined = false;
      socket.emit('leave');
    } else if (input == 'q' || input == 'quit') {
      socket.close();
      rl.close();
    } else if (input == 'n' || input == 'new') {
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
      try {
        const filePromises = filePaths.map(async (filePath) => {
          const name = path.basename(filePath);
          const data = await fsp.readFile(filePath, {encoding: 'base64'});
          return {name, data};
        });
        const files = await Promise.all(Object.values(filePromises));
        const {res, err} = await socket.emitWithAck('new_job', {files});
        if (err) {
          console.error(err);
          continue;
        }
        const delcomPath = path.join(os.tmpdir(), 'DELCOM');
        if (!fs.existsSync(delcomPath)) {
          await fsp.mkdir(delcomPath);
        }
        const workingDir = await fsp.mkdtemp(`${delcomPath}${path.sep}res`);
        const resPromises = [
          fsp.writeFile(
              `${workingDir}${path.sep}run.stdout`,
              res.run.stdout,
          ),
          fsp.writeFile(
              `${workingDir}${path.sep}run.stderr`,
              res.run.stderr,
          ),
          fsp.writeFile(
              `${workingDir}${path.sep}build.stdout`,
              res.build.stdout,
          ),
          fsp.writeFile(
              `${workingDir}${path.sep}build.stderr`,
              res.build.stderr,
          ),
        ];
        await Promise.all(resPromises);
        console.log(`Job finished! Results stored in ${workingDir}`);
      } catch (err) {
        console.error(err);
        console.error('failed to emit files');
      }
    } else if (input == 'c' || input == 'clear') {
      console.clear();
    }
  }
});

socket.on('job', async (job, callback) => {
  config.working = true;
  const out = {
    build: {
      stdout: '',
      stderr: '',
    },
    run: {
      stdout: '',
      stderr: '',
    },
  };
  try {
    const delcomPath = path.join(os.tmpdir(), 'DELCOM');
    if (!fs.existsSync(delcomPath)) {
      await fsp.mkdir(delcomPath);
    }
    const workingDir = await fsp.mkdtemp(`${delcomPath}${path.sep}job`);
    const dockerName = path.basename(workingDir).toLowerCase();
    console.info(`Created job directory: ${workingDir}`);
    for (const fileInfo of job.files) {
      fsp.writeFile(
          `${workingDir}${path.sep}${fileInfo.name}`,
          fileInfo.data,
          {encoding: 'base64'},
      );
    }
    const build = spawn(
        'docker',
        ['build', `-t${dockerName}`, '--progress=plain', workingDir],
    );
    build.stdout.on('data', (chunk) => {
      out.build.stdout = out.build.stdout + chunk.toString();
    });
    build.stderr.on('data', (chunk) => {
      out.build.stderr = out.build.stderr + chunk.toString();
    });
    build.on('close', async (code) => {
      console.error(`\nBuild closed with code ${code}\n`);
      if (code) {
        callback({res: out, err: `Build closed with code ${code}`});
        return;
      }
      const run = spawn('docker', ['run', dockerName]);
      run.stdout.on('data', (chunk) => {
        out.run.stdout = out.run.stdout + chunk.toString();
      });
      run.stderr.on('data', (chunk) => {
        out.run.stderr = out.run.stderr + chunk.toString();
      });
      run.on('close', ()=> {
        callback({res: out, err: undefined});
      });
    });
  } catch (err) {
    console.error(err);
    callback({res: out, err: err});
  } finally {
    config.working = false;
  }
});

socket.on('disconnect', (reason) => {
  console.log(`Disconnected: ${reason}`);
});
