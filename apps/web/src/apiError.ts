// Plain fields, not parameter properties: scripts/capture-demo.mjs loads this module with Node's type stripping,
// which does not accept parameter properties.
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
