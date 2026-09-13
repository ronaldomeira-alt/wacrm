declare module 'heic-decode' {
  interface DecodeOptions {
    buffer: Buffer | Uint8Array | ArrayBuffer
  }
  interface DecodedImage {
    data: Uint8ClampedArray | Uint8Array
    width: number
    height: number
  }
  function decode(options: DecodeOptions): Promise<DecodedImage>
  export default decode
}
