// GitBook CLI 프로세스에 미리 올린다(--import). CLI가 API에 보내는 인증 값을 IPC로 부모에게만 넘긴다.
const original = globalThis.fetch;

globalThis.fetch = (input, init) => {
  const request = new Request(input, init);
  const authorization = request.headers.get('authorization');
  const [endpoint, path] = request.url.split('/v1/');
  if (path !== undefined && authorization?.startsWith('Bearer ')) process.send?.({ endpoint, authorization });
  return original(input, init);
};
