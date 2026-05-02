<?php

namespace App\Services;

use Exception;
use phpseclib3\Net\SSH2;
use phpseclib3\Crypt\PublicKeyLoader;

class WakeOnLanService
{
    public function wake(string $machineId): void
    {
        $machineConfig = config("wol.machines.{$machineId}");
        if (!$machineConfig) {
            throw new Exception("Machine '{$machineId}' not found in configuration");
        }

        $bastionKey = $machineConfig['bastion'];
        $bastionConfig = config("wol.bastions.{$bastionKey}");
        if (!$bastionConfig) {
            throw new Exception("Bastion '{$bastionKey}' not found in configuration");
        }

        $this->sendMagicPacket($machineConfig, $bastionConfig);
    }

    private function sendMagicPacket(array $machineConfig, array $bastionConfig): void
    {
        try {
            // Connect to jump host (VPS) first
            $jumpSsh = new SSH2($bastionConfig['jump_host'], 22);
            if (!$this->authenticate($jumpSsh, $bastionConfig, true)) {
                throw new Exception("Failed to authenticate to jump host");
            }

            // Open a forwarded channel from jump host to bastion
            $forwarded = $jumpSsh->openTunnel(
                $bastionConfig['host'],
                $bastionConfig['port']
            );

            if (!$forwarded) {
                throw new Exception("Failed to open forwarded tunnel to bastion");
            }

            // Connect to bastion through the tunnel
            $bastionSsh = new SSH2($forwarded);
            if (!$this->authenticate($bastionSsh, $bastionConfig, false)) {
                $jumpSsh->disconnect();
                throw new Exception("Failed to authenticate to bastion");
            }

            // Build the WOL command
            $mac = $machineConfig['mac'];
            $broadcast = $machineConfig['broadcast'];
            $command = "wakeonlan -i {$broadcast} {$mac}";

            // Execute WOL command
            $result = $bastionSsh->exec($command);

            if ($bastionSsh->getExitStatus() !== 0) {
                throw new Exception("WOL command failed: {$result}");
            }

            $bastionSsh->disconnect();
            $jumpSsh->disconnect();
        } catch (Exception $e) {
            throw new Exception("WOL error: " . $e->getMessage());
        }
    }

    private function authenticate(SSH2 $ssh, array $config, bool $isJumpHost): bool
    {
        if ($config['auth'] === 'key') {
            if (!$config['key_path'] || !file_exists($config['key_path'])) {
                throw new Exception("SSH key file not found at: " . ($config['key_path'] ?? 'null'));
            }

            $key = PublicKeyLoader::load(
                file_get_contents($config['key_path'])
            );

            return $ssh->login($config['user'], $key);
        } else {
            // Password authentication
            $password = $config['password'];
            if (!$password) {
                throw new Exception("No password configured for SSH authentication");
            }

            return $ssh->login($config['user'], $password);
        }
    }
}
