const PROJECT_SETUP_OPENED_KEY = 'coleo_project_setup_opened';

export function hasOpenedProjectSetup(): boolean {
  return localStorage.getItem(PROJECT_SETUP_OPENED_KEY) === 'true';
}

export function markProjectSetupOpened(): void {
  localStorage.setItem(PROJECT_SETUP_OPENED_KEY, 'true');
}
