---
# Welcome page for the `safe_code` type - fr variant. See `welcome.md` for the
# structure; only user-visible values are translated.
greeting: Que dois-je lire ou modifier ?
suggestions:
  - title: Comprendre ce code
    description: Explorez l’architecture, les modules et les flux importants.
    prompt: Aidez-moi à comprendre ce code. Identifiez les composants principaux, les points d’entrée importants, le flux de données et les parties que je devrais lire en premier.
  - title: Relire le code
    description: Trouvez les bugs, les risques et les pistes d’amélioration.
    prompt: Relisez ce code du point de vue de la correction, des bugs, des régressions, des risques de sécurité, des problèmes de performance et de la maintenabilité. Placez les constats les plus importants en premier.
  - title: Corriger un bug
    description: Trouvez la cause et faites la plus petite modification sûre.
    prompt: Enquêtez sur ce bug en lisant le code, identifiez la cause racine et appliquez la correction la plus petite et la plus fiable. Vérifiez la modification en relisant les fichiers concernés plutôt qu’en exécutant quoi que ce soit, et dites-moi ce qu’il reste à exécuter en dehors de SafeCode.
  - title: Développer une fonctionnalité
    description: Effectuez la modification dans tous les fichiers concernés.
    prompt: Aidez-moi à développer une nouvelle fonctionnalité dans ce projet. Lisez d’abord le code et l’architecture concernés, puis proposez un plan d’implémentation et effectuez les modifications. Vérifiez le résultat en inspectant les fichiers obtenus et énumérez ce qu’il reste à compiler ou à tester en dehors de SafeCode.
  - title: Refactoriser le code
    description: Améliorez la structure sans changer le comportement.
    prompt: Refactorisez ce code pour le rendre plus simple, plus clair et plus facile à maintenir, tout en préservant le comportement existant. Expliquez les principales modifications et vérifiez par la lecture que rien d’autre ne dépend de ce que vous avez déplacé.
  - title: Écrire des tests
    description: Écrivez-les ici, exécutez-les ailleurs.
    prompt: Lisez le comportement actuel et les tests existants, identifiez les lacunes et les cas limites importants, puis écrivez des tests qui les couvrent. Suivez le style des tests environnants. Je les exécuterai en dehors de SafeCode.
---
