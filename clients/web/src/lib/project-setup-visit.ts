const PROJECT_SETUP_OPENED_KEY = 'coleo_project_setup_opened';
const PROJECT_SETUP_HELP_DISMISSED_KEY = 'coleo_project_setup_help_dismissed';

export function hasOpenedProjectSetup(): boolean {
  return localStorage.getItem(PROJECT_SETUP_OPENED_KEY) === 'true';
}

export function markProjectSetupOpened(): void {
  localStorage.setItem(PROJECT_SETUP_OPENED_KEY, 'true');
}

export function hasDismissedProjectSetupHelp(): boolean {
  return localStorage.getItem(PROJECT_SETUP_HELP_DISMISSED_KEY) === 'true';
}

export function dismissProjectSetupHelp(): void {
  localStorage.setItem(PROJECT_SETUP_HELP_DISMISSED_KEY, 'true');
}
