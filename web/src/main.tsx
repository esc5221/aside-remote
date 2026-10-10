import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme, loadTheme, applyTextSize, loadTextSize } from './theme';
import './global.css';

applyTheme(loadTheme());
applyTextSize(loadTextSize());
createRoot(document.getElementById('root')!).render(<App />);
