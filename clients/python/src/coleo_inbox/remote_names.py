"""Pure name suggestions, matching the legacy CLI's word lists and probabilities."""
import random

PREFIXES = ("Port Bianc Farin Viol Sal Cyr Phal Marp Octo Hapal Argo Ciru Vul Trem Abd Eus Xen Zyr Kith Vor "
            "Thex Nex Vex Qor Drak Ix Ax Ul Orn Eth Ath Iss Neur Cog Syn Psi Mem Sen Cort Gan Astr Cos Lun "
            "Sol Neb Vac Orb Gal Bio Chit Ceph Mant Arch Proto Endo Exo").split()
SUFFIXES = ("ia ix us ax ora ara ida idae opus pod thus yx on os as is iel ael oth eth yn an en in ar or ur ir "
            "al el il ol ius eus aia eia ion eon ian ean rix rax nex lex tex dex vex pex apse axon ode ome ine ene ase ate").split()
EPITHETS = ("Prime Alpha Nova Zero One Null Crimson Azure Obsidian Amber Jade Onyx Major Minor Rex Apex Core "
            "Node Awake Dreaming Seeking Weaving Watching Void Flux Drift Spin Wave Pulse").split()
CLASSICS = "Portia Bianca Fabian Viola Yusuf Paul Helena Meshner Avrana Holsten Lain Guyen".split()
PLAYFUL = ["Copernicus", "Gerald", "Featherwand", "Sparklegirl", "Fluffnut", "Pom Pom",
           "Professor Pancake", "Princess Sparklehorse"]


def name():
    if random.random() < 0.05:
        return random.choice(CLASSICS)
    if random.random() < 0.05:
        return random.choice(PLAYFUL)
    return (random.choice(PREFIXES) + random.choice(SUFFIXES)).capitalize()


def suggestions(count, stats=False):
    names = list(dict.fromkeys(name() for _ in range(count * 10)))[:count]
    result = {"names": names}
    if stats:
        base = len(PREFIXES) * len(SUFFIXES)
        result["stats"] = {"prefixes": len(PREFIXES), "suffixes": len(SUFFIXES), "epithets": len(EPITHETS),
                           "classics": len(CLASSICS), "baseCombinations": base,
                           "withEpithets": base * len(EPITHETS),
                           "total": base * (len(EPITHETS) + 1) + len(CLASSICS)}
    return result
