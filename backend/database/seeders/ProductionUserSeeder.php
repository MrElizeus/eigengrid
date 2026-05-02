<?php

namespace Database\Seeders;

use App\Models\User;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Hash;

class ProductionUserSeeder extends Seeder
{
    public function run(): void
    {
        User::updateOrCreate(
            ['email' => 'eliseoalejandro.huetagoyena@gmail.com'],
            [
                'name' => 'Arkana',
                'password' => Hash::make('EigenGrid2024!'),
            ]
        );

        $this->command->info('✓ User created/updated: eliseoalejandro.huetagoyena@gmail.com');
        $this->command->info('✓ Name: Arkana');
        $this->command->info('✓ Password: EigenGrid2024!');
    }
}
