import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import TaggingLab from './TaggingLab';

createRoot(document.getElementById('root')!).render(<StrictMode><TaggingLab /></StrictMode>);
