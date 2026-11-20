// An error that carries the HTTP status to send. Anything else is a bug and becomes a 500.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
