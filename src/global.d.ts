/// <reference types="vite/client" />
import type { DesktopAPI } from '../shared/model';
declare global { interface Window { desktop?: DesktopAPI } }
