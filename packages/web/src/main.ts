import './lib/setup.ts';
import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { installTestHooks } from './lib/testhooks.ts';

installTestHooks();
mount(App, { target: document.getElementById('app')! });
