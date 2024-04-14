/* eslint-disable no-await-in-loop */
import { Client } from 'delcom-client';
import readline from 'node:readline/promises';
import dotenv from 'dotenv';
import { isIPv4 } from 'is-ip';
import { exit } from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import type * as DCST from 'delcom-server';

function getRandElement<T>(arr: T[]): T | undefined {
  if (arr.length == 0) {
    return undefined;
  }
  return arr[Math.floor(Math.random() * arr.length)];
}

dotenv.config();

let ip = process.env.IP;
let port = parseInt(process.env.PORT || '0');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const helpMessage = () => {
  // console.clear();
  return '\nCommands: \n\
\tj join:  \tJoin the worker network\n\
\tl leave: \tLeave the working network\n\
\tq quit:  \tQuit the application\n\
\tn new:   \tCreate a new job (interactive)\n\
\tw workers:\tList all available workers\n\
\tc clear: \tClear the console\n\
';
};

while (!ip || !isIPv4(ip)) {
  ip = await rl.question('Please input a valid IP');
}

while (port <= 0 || port > 65535) {
  try {
    port = parseInt(await rl.question('Please input a valid port'));
  } catch (err) {
    console.trace(err);
  }
}

console.log('Connecting...');
const client = new Client(ip, port, { timeout: 60000 });
await client.init();
console.log('Connected!');

// eslint-disable-next-line no-constant-condition
while (true) {
  try {
    const input = await rl.question(helpMessage());
    if (input == 'j' || input == 'join') {
      console.log('Joining Worker Pool!...');
      await client.joinWorkforce();
      console.log('Joined Worker Pool!');
    } else if (input == 'l' || input == 'leave') {
      console.log('Leaving Worker Pool...');
      await client.leaveWorkforce();
      console.log('Left Worker Pool!');
    } else if (input == 'q' || input == 'quit') {
      client.quit();
      rl.close();
      exit();
    } else if (input == 'w' || input == 'workers') {
      const workersObj = await client.getWorkers();
      if (workersObj.err) {
        console.error('Error getting workers!');
        console.log(workersObj.err);
      } else if (workersObj.res) {
        {
          const workers = workersObj.res;
          console.log(workers);
        }
      }
    } else if (input == 'n' || input == 'new') {
      const workersOut = await client.getWorkers();
      if (workersOut.err) {
        console.warn('Error in geting workers!');
        console.error(workersOut.err);
      } else if (workersOut.res) {
        const filePaths: fs.PathLike[] = [];
        filePaths[0] = await rl.question('Please input the Dockerfile path: ');
        while (
          !filePaths[0] ||
          !fs.existsSync(filePaths[0]) ||
          !(await fs.promises.lstat(filePaths[0])).isFile() ||
          path.basename(filePaths[0].toString()) != 'Dockerfile'
        ) {
          filePaths[0] = await rl.question(
            'Not a valid Dockerfile. Please input the Dockerfile path: '
          );
        }
        let depPath;
        do {
          console.log(filePaths);
          depPath = await rl.question(
            'Input a dependency file path (or blank to continue): '
          );
          if (
            depPath &&
            fs.existsSync(depPath) &&
            (await fs.promises.lstat(depPath)).isFile()
          ) {
            filePaths.push(depPath);
          }
        } while (depPath);
        console.log('Dependencies collected, continuing...');
        const workers = (await client.getWorkers())?.res;
        if (!workers) {
          throw Error('No workers!');
        }
        console.log(workers);
        let target = await rl.question(
          'Input a workerID from above (or blank for random): '
        );
        if (!target) {
          target =
            getRandElement(
              workers.map((worker) => {
                return worker.workerID;
              })
            ) || '';
        }
        console.log('Chosen target, sending job...');
        const dir = await client.delegateJob(target, filePaths, {
          whenJobAssigned: (actDir) => {
            console.log(`Job Assigned! Output at ${actDir}`);
          },
          whenFilesSent: () => {
            console.log('Files sent!');
          },
          whenJobDone: () => {
            console.log('Job Done!');
          },
        });
        console.log('Job done! See files at:');
        console.log(dir);
      }
    } else if (input == 'c' || input == 'clear') {
      console.clear();
    }
  } catch (err) {
    console.error(err);
    console.error('err in new job routine');
  }
}
