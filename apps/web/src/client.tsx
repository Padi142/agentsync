import { StartClient } from '@tanstack/react-start/client';
import { hydrateRoot } from 'react-dom/client';
const root = document.getElementById('app');

if (!root) {
  throw new Error('The application root is missing');
}

hydrateRoot(root, <StartClient />);
