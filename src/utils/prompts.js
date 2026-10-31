import { input, select } from '@inquirer/prompts';

export { input, select };

// Asks with one @inquirer/prompts function (input, select); Ctrl-C answers null instead of throwing
// ExitPromptError, so a command can stop cleanly rather than print a stack trace
export async function ask(prompt, options) {
  try {
    return await prompt(options);
  } catch (error) {
    if (error?.name === 'ExitPromptError') return null;
    throw error;
  }
}
