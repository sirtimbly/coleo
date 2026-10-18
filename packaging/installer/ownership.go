package main

// An explicit role owns its distribution and any dependencies. Removing that
// role releases all of its claims, leaving other explicit/dependency owners intact.
func removeOwner(receipt *Receipt, role string) {
	for name, pkg := range receipt.Packages {
		remaining := []string{}
		for _, owner := range pkg.Roles {
			if owner != role {
				remaining = append(remaining, owner)
			}
		}
		if len(remaining) == 0 {
			delete(receipt.Packages, name)
		} else {
			pkg.Roles = remaining
			receipt.Packages[name] = pkg
		}
	}
}
