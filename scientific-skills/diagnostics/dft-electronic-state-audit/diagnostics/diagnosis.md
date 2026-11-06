# State identity and SCF stability

For two converged guesses, compare final orbital occupations, spin densities on the same atomic partition and energies on identical geometries. Two inputs can converge to the same root. An energy or a multiplicity label alone cannot identify a local coupling pattern.

## Negative orbital curvature

Report the tested rotation space and the lowest converged orbital Hessian eigenvalue. If a destabilizing direction exists, retain the old orbitals and the state reached after a new guess as distinct evidence. Check state identity again before using either geometry gradient. The vibrational Hessian measures nuclear curvature and answers a different question.

## Sensitivity reversal

If a denser grid reverses a small spin gap, compare the states on identical geometries with converged SCF residuals and independently increased grid accuracy. Record the sign and size of each shift. If alternate defensible functionals still favor different states, retain both assignments and seek a matched reference.
