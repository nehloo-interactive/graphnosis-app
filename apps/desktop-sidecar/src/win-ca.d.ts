declare module 'win-ca' {
  function inject(mode: '+' | string): void;
  function each(cb: (cert: Buffer) => void): void;
}
