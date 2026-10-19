import * as inquirer from '@inquirer/prompts';
import { describe, expect, it, vi } from 'vitest';
import { inquirerPrompts, isPromptCancelled } from './inquirerPrompts';

vi.mock('@inquirer/prompts', () => ({
  checkbox: vi.fn(),
  confirm: vi.fn(),
  input: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
}));

describe('inquirerPrompts', () => {
  it('passes a confirm question on and returns the answer', async () => {
    vi.mocked(inquirer.confirm).mockResolvedValue(true);
    const options = { message: 'Overwrite?', default: false };

    expect(await inquirerPrompts.confirm(options)).toBe(true);
    expect(inquirer.confirm).toHaveBeenCalledWith(options);
  });

  it('passes a checkbox question on and returns the answer', async () => {
    vi.mocked(inquirer.checkbox).mockResolvedValue(['a']);
    const options = { message: 'Pick', choices: [{ name: 'a', value: 'a', checked: true }] };

    expect(await inquirerPrompts.checkbox(options)).toEqual(['a']);
    expect(inquirer.checkbox).toHaveBeenCalledWith(options);
  });

  it('passes a checkbox validator on, and it reads the ticked choices as inquirer builds them', async () => {
    vi.mocked(inquirer.checkbox).mockResolvedValue(['a']);
    const validate = vi.fn((selected: readonly { value: string }[]) =>
      selected.some((choice) => choice.value === 'a') ? (true as const) : 'keep a ticked',
    );

    await inquirerPrompts.checkbox({
      message: 'Pick',
      choices: [{ name: 'a', value: 'a' }],
      validate,
    });

    const passed = vi.mocked(inquirer.checkbox).mock.calls.at(-1)?.[0].validate;
    // The shape @inquirer/checkbox hands to validate: whole normalized choices, not bare values.
    const ticked = {
      value: 'a',
      name: 'a',
      short: 'a',
      checkedName: 'a',
      disabled: false,
      checked: true,
    };
    expect(passed?.([ticked])).toBe(true);
    expect(passed?.([])).toBe('keep a ticked');
  });

  it('passes an input question on, validator included, and returns the answer', async () => {
    vi.mocked(inquirer.input).mockResolvedValue('typed');
    const options = { message: 'Name', default: 'x', validate: () => true as const };

    expect(await inquirerPrompts.input(options)).toBe('typed');
    expect(inquirer.input).toHaveBeenCalledWith(options);
  });

  it('passes a select question on and returns the answer', async () => {
    vi.mocked(inquirer.select).mockResolvedValue('light');
    const options = {
      message: 'Profile',
      choices: [{ name: 'light', value: 'light' as const, description: 'small' }],
      default: 'light' as const,
    };

    expect(await inquirerPrompts.select(options)).toBe('light');
    expect(inquirer.select).toHaveBeenCalledWith(options);
  });

  it('passes a password question on and returns the answer', async () => {
    vi.mocked(inquirer.password).mockResolvedValue('hunter2');
    const options = { message: 'Password', validate: () => true as const };

    expect(await inquirerPrompts.password(options)).toBe('hunter2');
    expect(inquirer.password).toHaveBeenCalledWith(options);
  });
});

describe('isPromptCancelled', () => {
  it('is true for the error inquirer throws on Ctrl+C', () => {
    const cancelled = Object.assign(new Error('User force closed the prompt'), {
      name: 'ExitPromptError',
    });

    expect(isPromptCancelled(cancelled)).toBe(true);
  });

  it('is false for any other error', () => {
    expect(isPromptCancelled(new Error('tty exploded'))).toBe(false);
    expect(isPromptCancelled(new TypeError('nope'))).toBe(false);
  });

  it('is false for something that is not an error, even with the same name', () => {
    expect(isPromptCancelled({ name: 'ExitPromptError' })).toBe(false);
    expect(isPromptCancelled('ExitPromptError')).toBe(false);
    expect(isPromptCancelled(undefined)).toBe(false);
  });
});
