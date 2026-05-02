<?php

return [
    'bastions' => [
        'rpi-home' => [
            'jump_host' => env('WOL_BASTION_RPI_JUMP_HOST', '145.223.94.180'),
            'jump_user' => env('WOL_BASTION_RPI_JUMP_USER', 'rpiwol'),
            'host'      => env('WOL_BASTION_RPI_HOST', 'localhost'),
            'port'      => (int) env('WOL_BASTION_RPI_PORT', 2222),
            'user'      => env('WOL_BASTION_RPI_USER', 'root'),
            'auth'      => env('WOL_BASTION_RPI_AUTH', 'password'),
            'password'  => env('WOL_BASTION_RPI_PASSWORD'),
            'key_path'  => env('WOL_BASTION_RPI_KEY_PATH'),
        ],
    ],

    'machines' => [
        'workstation' => [
            'bastion'      => env('WOL_MACHINE_WS_BASTION', 'rpi-home'),
            'mac'          => env('WOL_MACHINE_WS_MAC', 'a8:a1:59:27:c7:36'),
            'broadcast'    => env('WOL_MACHINE_WS_BROADCAST', '192.168.1.255'),
            'ssh_host'     => env('WOL_MACHINE_WS_SSH_HOST', 'localhost'),
            'ssh_port'     => (int) env('WOL_MACHINE_WS_SSH_PORT', 2222),
            'ssh_user'     => env('WOL_MACHINE_WS_SSH_USER', 'root'),
            'ssh_auth'     => env('WOL_MACHINE_WS_SSH_AUTH', 'password'),
            'ssh_password' => env('WOL_MACHINE_WS_SSH_PASSWORD'),
            'ssh_key_path' => env('WOL_MACHINE_WS_SSH_KEY_PATH'),
        ],
    ],
];
