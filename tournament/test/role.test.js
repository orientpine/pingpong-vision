import { expect, test } from 'bun:test';
import { cameraStatus, initialRole, soundState, viewerLayout } from '../public/role.js';

test('a device keeps its chosen role; any device without one asks, a PIN device too', () => {
  expect(initialRole('viewer')).toBe('viewer');
  expect(initialRole('desk')).toBe('desk');
  expect(initialRole(null)).toBeNull();
  expect(initialRole('admin')).toBeNull();
});

test('camera status: filming beats waiting beats cut off; a camera that never linked and left is not shown', () => {
  const linked = { id: 'a', online: true, linked: true };
  const waiting = { id: 'b', online: true, linked: false };
  const lost = { id: 'c', online: false, linked: true };
  const gone = { id: 'd', online: false, linked: false };
  expect(cameraStatus([waiting, lost, linked]).kind).toBe('linked');
  expect(cameraStatus([lost, waiting]).camera.id).toBe('b');
  expect(cameraStatus([gone, lost]).kind).toBe('offline');
  expect(cameraStatus([gone]).kind).toBe('none');
  expect(cameraStatus(undefined).kind).toBe('none');
});

test('only the screen the server picked as speaker reads the score', () => {
  expect(soundState({ on: false, unlocked: true, conn: 'x', speaker: 'x' })).toBe('off');
  expect(soundState({ on: true, unlocked: false, conn: 'x', speaker: null })).toBe('needTap');
  expect(soundState({ on: true, unlocked: true, conn: 'x', speaker: 'x' })).toBe('on');
  expect(soundState({ on: true, unlocked: true, conn: 'x', speaker: 'y' })).toBe('elsewhere');
  expect(soundState({ on: true, unlocked: true, conn: 'x', speaker: null })).toBe('claiming');
});

test('only a viewer on a big screen gets the scoreboard layout; phones and other roles keep theirs', () => {
  expect(viewerLayout('viewer', 1920, 1080)).toBe('wide');
  expect(viewerLayout('viewer', 1280, 720)).toBe('wide');
  expect(viewerLayout('viewer', 768, 1024)).toBe('tall');
  expect(viewerLayout('viewer', 393, 852)).toBeNull();
  expect(viewerLayout('viewer', 852, 393)).toBeNull();
  expect(viewerLayout('referee', 1920, 1080)).toBeNull();
  expect(viewerLayout(null, 1920, 1080)).toBeNull();
});
