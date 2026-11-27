// CLI 브라우저 로그인. CLI는 Windows에서 주소를 `&` 앞에서 잘라 열므로 전체 주소를 다시 연다.
import { spawn } from 'node:child_process';
import { CLI } from './gitbook.mjs';

export function login() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'login'], { stdio: ['inherit', 'pipe', 'inherit'] });
    let output = '';
    let opened = process.platform !== 'win32';
    child.stdout.on('data', (data) => {
      process.stdout.write(data);
      if (opened) return;
      output += data;
      const url = /(https:\/\/oauth\.gitbook\.com\/authorize\?\S+)\s/.exec(output)?.[1];
      if (!url) return;
      opened = true;
      // 셸을 거치지 않으므로 `&`가 해석되지 않는다.
      spawn('rundll32', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore' });
      process.stdout.write('전체 로그인 주소를 새 탭으로 열었습니다. client_id 오류가 난 탭은 닫으세요.\n');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}
