/* eslint-disable no-await-in-loop */
import { Client } from 'delcom-client';
import readline from 'node:readline/promises';
import dotenv from 'dotenv';
import {isIPv4} from 'is-ip';
import { exit } from 'node:process';

function getRandElement<T>(arr:T[]) {
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
  return '\nOptions: \n\
\tj join:  \tJoin the worker network\n\
\tl leave: \tLeave the working network\n\
\tq quit:  \tQuit the application\n\
\tn new:   \tCreate a new job\n\
\tc clear: \tClear the console\n\
';
};

while (!ip || !isIPv4(ip)) {
  ip = await rl.question('Please input a valid IP');
}

while (port < 0 || port > 65535) {
  try {
    port = parseInt(await rl.question('Please input a valid port'));
  } catch (err) {
    console.trace(err);
  }
}

console.log('Connecting...');
const client = new Client(ip, port);
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
      await client.joinWorkforce();
      console.log('Left Worker Pool!');
    } else if (input == 'q' || input == 'quit') {
      rl.close();
      exit();
    } else if (input == 'n' || input == 'new') {
      const workersOut = await client.getWorkers();
      if (workersOut.err) {
        console.warn('Error in geting workers!');
        console.error(workersOut.err);
      } else if (workersOut.res) {
        const target = getRandElement(workersOut.res);
        if (target) {
          // TODO why is this not detected?
          console.log(target.workerID);
          console.log('Chosen target, sending job...');
          const dir = await client.delegateJob( // TODO make success an object
            target.workerID,
            [
              '../DemoFiles/python-hello-world/Dockerfile',
              '../DemoFiles/python-hello-world/my_prog.py',
            ],
            {
              whenJobAssigned: (actDir) => {
                console.log(`Job Assigned! Output at ${actDir}`);
              },
              whenFilesSent: () => {
                console.log('Files sent!');
              },
              whenJobDone: () => {
                console.log('Job Done!');
              },
            },
          );
          console.log('Job done! See files at:');
          console.log(dir);
        } else {
          console.warn('No available workers!');
        }
      }
    } else if (input == 'c' || input == 'clear') {
      console.clear();
    } 
  } catch (err) {
    console.error(err);
    console.error('err in new job routine');
  }
}
