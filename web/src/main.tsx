import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme, loadTheme } from './theme';
import './global.css';

applyTheme(loadTheme());
createRoot(document.getElementById('root')!).render(<App />);
