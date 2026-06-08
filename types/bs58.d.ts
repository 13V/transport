// Minimal ambient types for bs58 v4 (no bundled or @types declarations). We use
// only encode/decode. v4 exports the module via `module.exports`, so a default
// import (`import bs58 from 'bs58'`) resolves to this object under
// esModuleInterop, which tsconfig enables.
declare module 'bs58' {
  const bs58: {
    encode(buffer: Uint8Array | number[]): string;
    decode(str: string): Uint8Array;
  };
  export default bs58;
}
