/** Section name → [url suffix, is_overlay]. */
export type SectionConfig = readonly [suffix: string, isOverlay: boolean];

export const PERSON_SECTIONS: Record<string, SectionConfig> = {
  main_profile: ["/", false],
  experience: ["/details/experience/", false],
  education: ["/details/education/", false],
  interests: ["/details/interests/", false],
  honors: ["/details/honors/", false],
  languages: ["/details/languages/", false],
  certifications: ["/details/certifications/", false],
  skills: ["/details/skills/", false],
  projects: ["/details/projects/", false],
  contact_info: ["/overlay/contact-info/", true],
  posts: ["/recent-activity/all/", false],
};

export const COMPANY_SECTIONS: Record<string, SectionConfig> = {
  about: ["/about/", false],
  posts: ["/posts/", false],
  jobs: ["/jobs/", false],
};

export interface ParsedSections {
  requested: Set<string>;
  unknown: string[];
}

export function parsePersonSections(sections?: string | null): ParsedSections {
  const requested = new Set<string>(["main_profile"]);
  const unknown: string[] = [];
  if (!sections) return { requested, unknown };
  for (const raw of sections.split(",")) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    if (name in PERSON_SECTIONS) requested.add(name);
    else unknown.push(name);
  }
  return { requested, unknown };
}
