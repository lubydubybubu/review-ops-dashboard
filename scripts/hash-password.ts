/**
 * npm run hash-password
 * Prompts for the owner password on the terminal (hidden, asked twice) and prints the
 * OPS_PASSWORD_HASH line. Deliberately refuses argv/stdin pipes so the password never
 * lands in shell history or process listings.
 */
import { hashPassword } from '../src/server/auth/password';

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    let value = '';
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const done = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

if (process.argv.length > 2) {
  console.error('Do not pass the password as an argument. Run without arguments and type it at the prompt.');
  process.exit(1);
}
if (!process.stdin.isTTY) {
  console.error('hash-password needs an interactive terminal (TTY).');
  process.exit(1);
}

try {
  const first = await promptHidden('새 비밀번호 (8자 이상): ');
  if (first.length < 8) throw new Error('비밀번호는 8자 이상이어야 합니다.');
  const second = await promptHidden('한 번 더 입력: ');
  if (first !== second) throw new Error('두 비밀번호가 다릅니다.');
  const hash = await hashPassword(first);
  console.log('\n.env.local 에 아래 줄을 넣으세요:\n');
  console.log(`OPS_PASSWORD_HASH=${hash}`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
