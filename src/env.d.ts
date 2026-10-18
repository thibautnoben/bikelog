/// <reference types="@astrojs/cloudflare/types.d.ts" />

declare namespace App {
  interface Locals {
    athlete: import('./lib/db').Athlete | null;
  }
}
