// Kept in its own module and loaded on demand, so the HEIC decoder (WebAssembly)
// only starts up in the functions and moments that need it.
import decode from 'heic-decode';

export { decode };
