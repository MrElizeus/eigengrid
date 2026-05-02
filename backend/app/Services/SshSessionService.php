<?php

namespace App\Services;

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Str;

class SshSessionService
{
    public function createSession(string $machineId, int $userId): array
    {
        $machineConfig = config("wol.machines.{$machineId}");
        if (!$machineConfig) {
            throw new \Exception("Machine '{$machineId}' not found in configuration");
        }

        $bastionKey = $machineConfig['bastion'];
        $bastionConfig = config("wol.bastions.{$bastionKey}");
        if (!$bastionConfig) {
            throw new \Exception("Bastion '{$bastionKey}' not found in configuration");
        }

        // Generate a secure random token
        $token = Str::random(40);

        // Build the full session payload with all SSH credentials
        $payload = [
            'machine_id' => $machineId,
            'user_id' => $userId,
            'created_at' => now()->timestamp,
            'ssh_host' => $machineConfig['ssh_host'],
            'ssh_port' => $machineConfig['ssh_port'],
            'ssh_user' => $machineConfig['ssh_user'],
            'ssh_auth' => $machineConfig['ssh_auth'],
            'ssh_password' => $machineConfig['ssh_password'] ?? null,
            'ssh_key_path' => $machineConfig['ssh_key_path'] ?? null,
            'bastion' => [
                'jump_host' => $bastionConfig['jump_host'],
                'jump_user' => $bastionConfig['jump_user'],
                'host' => $bastionConfig['host'],
                'port' => $bastionConfig['port'],
                'user' => $bastionConfig['user'],
                'auth' => $bastionConfig['auth'],
                'password' => $bastionConfig['password'] ?? null,
                'key_path' => $bastionConfig['key_path'] ?? null,
            ],
        ];

        // Store in cache with 60 second TTL
        Cache::put("ssh_session_{$token}", $payload, now()->addSeconds(60));

        return [
            'token' => $token,
            'ws_url' => config('app.ssh_bridge_ws_url'),
        ];
    }

    public function getAndConsume(string $token): ?array
    {
        $cacheKey = "ssh_session_{$token}";

        // Retrieve the payload
        $payload = Cache::get($cacheKey);

        if (!$payload) {
            return null;
        }

        // Delete immediately (single-use token)
        Cache::forget($cacheKey);

        return $payload;
    }
}
