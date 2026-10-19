export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}
export const badRequest = (m: string) => new HttpError(400, m, 'bad_request');
export const forbidden = (m = 'Not allowed') => new HttpError(403, m, 'forbidden');
export const notFound = (m = 'Not found') => new HttpError(404, m, 'not_found');
export const conflict = (m: string) => new HttpError(409, m, 'conflict');
export const gone = (m: string) => new HttpError(410, m, 'gone');
