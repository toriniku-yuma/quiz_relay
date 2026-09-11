import { expect, test } from 'vitest';
import Button from '../src/client/components/Button';
import TextField from '../src/client/components/TextField';
import { cn } from '../src/client/lib/cn';

test('class overrides preserve independent theme and state utilities', () => {
  expect(
    cn('bg-key text-sm text-ink', false, { 'bg-accent': true }, ['px-4', 'px-6']),
  ).toBe('text-sm text-ink bg-accent px-6');

  const button = Button({
    tone: 'primary',
    className: 'px-6 bg-key enabled:active:translate-y-1',
  });

  const classes = button.props.className.split(' ');
  expect(classes).toContain('px-6');
  expect(classes).not.toContain('px-4');
  expect(classes).toContain('bg-key');
  expect(classes).not.toContain('bg-accent');
  expect(classes).toContain('text-on-accent');
  expect(classes).toContain('text-sm');
  expect(classes).toContain('enabled:active:translate-y-1');
  expect(classes).not.toContain('enabled:active:translate-y-0.5');
  expect(classes).toContain('disabled:opacity-45');

  const field = TextField({
    id: 'example',
    label: 'Example',
    className: 'p-4 bg-result',
  });

  const input = field.props.children[1];
  expect(input.props.className.split(' ')).toEqual(
    expect.arrayContaining(['p-4', 'bg-result', 'text-ink', 'border-line']),
  );
  expect(input.props.className.split(' ')).not.toContain('p-3');
  expect(input.props.className.split(' ')).not.toContain('bg-input');
});

test('custom button shadows support overrides without removing shadow colors', () => {
  expect(cn('shadow-button', 'shadow-none')).toBe('shadow-none');
  expect(cn('shadow-button', 'shadow-lg')).toBe('shadow-lg');
  expect(cn('shadow-lg', 'shadow-button')).toBe('shadow-button');
  expect(cn('shadow-button', 'shadow-edge')).toBe('shadow-button shadow-edge');

  const button = Button({
    className: 'shadow-none enabled:active:shadow-none',
  });

  const classes = button.props.className.split(' ');
  expect(classes).toContain('shadow-none');
  expect(classes).toContain('enabled:active:shadow-none');
  expect(classes).not.toContain('shadow-button');
  expect(classes).not.toContain('enabled:active:shadow-button-pressed');
  expect(classes).toContain('enabled:active:translate-y-0.5');
});
