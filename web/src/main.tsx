import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme, loadTheme, applyTextSize, loadTextSize, applyFont, loadFont, type FontOption } from './theme';
import './global.css';

applyTheme(loadTheme());
applyTextSize(loadTextSize());
// 저장된 본문 폰트를 목록이 오는 대로 적용한다 (기본 Wanted Sans 는 이미 로드돼 있다).
fetch('/api/font/list').then(response => response.json()).then((data: { fonts: FontOption[] }) => applyFont(loadFont(), data.fonts)).catch(() => {});
createRoot(document.getElementById('root')!).render(<App />);
